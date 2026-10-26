import { BusinessError } from '@kit.BasicServicesKit';
import { webSocket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import {
  DshConfigOption,
  DshDefaults,
  DshHelloInfo,
  DshOpenResult,
  DshRpcParams,
  DshRpcPayload,
  DshSessionsResult,
  DshWireFrame
} from '../model/DshTypes';
import { DshFormat } from '../util/DshFormat';

export type DshEventListener = (frame: DshWireFrame) => void;

interface DshPendingCall {
  resolve: (value: DshRpcPayload) => void;
  reject: (reason: Error) => void;
  timer: number;
}

interface DshRpcRequest {
  type: string;
  id: string;
  method: string;
  params: DshRpcParams;
}

interface DshAuthRequest {
  type: string;
  token: string;
}

export class DshClient {
  private static instanceValue: DshClient | undefined = undefined;

  private socket: webSocket.WebSocket | undefined = undefined;
  private pending: Map<string, DshPendingCall> = new Map<string, DshPendingCall>();
  private listeners: DshEventListener[] = [];
  private connectResolve: ((value: DshHelloInfo) => void) | undefined = undefined;
  private connectReject: ((reason: Error) => void) | undefined = undefined;
  private connectTimer: number = -1;
  private heartbeatTimer: number = -1;
  private lastMessageAt: number = 0;
  private sequence: number = 0;
  private helloInfo: DshHelloInfo = DshDefaults.hello();
  private serverUrl: string = '';
  private authToken: string = '';
  private transportConnected: boolean = false;

  private constructor() {
  }

  static getInstance(): DshClient {
    if (DshClient.instanceValue === undefined) {
      DshClient.instanceValue = new DshClient();
    }
    return DshClient.instanceValue;
  }

  isConnected(): boolean {
    return this.transportConnected;
  }

  getHello(): DshHelloInfo {
    return this.helloInfo;
  }

  getServerUrl(): string {
    return this.serverUrl;
  }

  getToken(): string {
    return this.authToken;
  }

  addEventListener(listener: DshEventListener): () => void {
    this.listeners.push(listener);
    return (): void => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  connect(inputUrl: string, token: string): Promise<DshHelloInfo> {
    const normalized = DshFormat.normalizeWsUrl(inputUrl);
    if (normalized.length === 0) {
      return Promise.reject(new Error('请输入有效的网关地址'));
    }
    if (token.trim().length === 0) {
      return Promise.reject(new Error('请输入访问令牌'));
    }

    const previousReject = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.closeSocket(false, '');
    if (previousReject !== undefined) {
      previousReject(new Error('连接已被新的连接替换'));
    }
    this.serverUrl = normalized;
    this.authToken = token.trim();

    return new Promise<DshHelloInfo>((resolve: (value: DshHelloInfo) => void,
      reject: (reason: Error) => void) => {
      let socket: webSocket.WebSocket;
      try {
        socket = webSocket.createWebSocket();
      } catch (error) {
        reject(new Error('无法创建 WebSocket'));
        return;
      }
      this.socket = socket;
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        this.failConnect('连接超时，请检查地址、端口与局域网');
      }, 15000);

      socket.on('open', (error: BusinessError) => {
        if (this.socket !== socket) {
          return;
        }
        if (error) {
          this.failConnect(`连接失败：${error.message}`);
          return;
        }
        const auth: DshAuthRequest = { type: 'auth', token: this.authToken };
        this.sendJson(JSON.stringify(auth));
      });

      socket.on('message', (error: BusinessError, data: string | ArrayBuffer) => {
        if (error || this.socket !== socket) {
          return;
        }
        this.handleMessage(data);
      });

      socket.on('close', (error: BusinessError, result: webSocket.CloseResult) => {
        if (this.socket !== socket) {
          return;
        }
        let reason = '连接已断开';
        if (result !== undefined && result.reason !== undefined && result.reason.length > 0) {
          reason = result.reason;
        }
        this.handleClose(reason);
      });

      socket.on('error', (error: BusinessError) => {
        if (this.socket !== socket) {
          return;
        }
        if (this.connectReject !== undefined) {
          this.failConnect(`网络错误：${error.message}`);
        } else {
          this.handleClose(`网络错误：${error.message}`);
        }
      });

      socket.connect(normalized, (error: BusinessError, value: boolean) => {
        if (error) {
          this.failConnect(`无法连接：${error.message}`);
        }
      });
    });
  }

  reconnect(): Promise<DshHelloInfo> {
    if (this.serverUrl.length === 0 || this.authToken.length === 0) {
      return Promise.reject(new Error('没有可用的连接信息'));
    }
    return this.connect(this.serverUrl, this.authToken);
  }

  disconnect(): void {
    this.closeSocket(true, '已断开连接');
    this.helloInfo = DshDefaults.hello();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    this.lastMessageAt = Date.now();
    let raw = '';
    try {
      if (typeof data === 'string') {
        raw = data;
      } else {
        const decoder = util.TextDecoder.create('utf-8');
        raw = decoder.decodeToString(new Uint8Array(data));
      }
    } catch (error) {
      return;
    }

    let frame: DshWireFrame;
    try {
      frame = JSON.parse(raw) as DshWireFrame;
    } catch (error) {
      return;
    }

    if (frame.type === 'hello') {
      this.helloInfo = this.helloFromFrame(frame);
      this.transportConnected = true;
      this.clearConnectTimer();
      this.startHeartbeat();
      this.emitStatus(true, '');
      this.emitBridgeStatus(this.helloInfo.online, '');
      const resolve = this.connectResolve;
      this.connectResolve = undefined;
      this.connectReject = undefined;
      if (resolve !== undefined) {
        resolve(this.helloInfo);
      }
      return;
    }

    if (frame.type === 'auth.error') {
      this.failConnect(frame.message ?? '访问令牌不正确');
      return;
    }

    if (frame.type === 'rpc.result') {
      this.resolvePending(frame);
      return;
    }

    if (frame.type === 'rpc.error') {
      this.rejectPending(frame);
      return;
    }

    if (frame.type === 'event') {
      this.emit(frame);
      return;
    }
  }

  private helloFromFrame(frame: DshWireFrame): DshHelloInfo {
    const workspace = frame.workspace ?? '';
    const info: DshHelloInfo = {
      name: frame.name ?? 'dsh-mobile-bridge',
      version: frame.version ?? '',
      pathValue: frame.path ?? '/dsh',
      workspace: workspace,
      defaultCwd: frame.defaultCwd ?? workspace,
      online: frame.online === true,
      agentName: frame.agent?.name ?? 'deepseek-harness-acp',
      agentVersion: frame.agent?.version ?? ''
    };
    return info;
  }

  private resolvePending(frame: DshWireFrame): void {
    const id = frame.id ?? '';
    const call = this.pending.get(id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(id);
    if (call.timer >= 0) {
      clearTimeout(call.timer);
    }
    call.resolve(frame.result ?? DshDefaults.rpcPayload());
  }

  private rejectPending(frame: DshWireFrame): void {
    const id = frame.id ?? '';
    const call = this.pending.get(id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(id);
    if (call.timer >= 0) {
      clearTimeout(call.timer);
    }
    call.reject(new Error(frame.error?.message ?? '网关请求失败'));
  }

  private handleClose(reason: string): void {
    const socket = this.socket;
    this.transportConnected = false;
    this.socket = undefined;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.rejectAllPending('连接已断开');
    const reject = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    if (reject !== undefined) {
      reject(new Error(reason));
    }
    if (socket !== undefined) {
      socket.off('message');
      socket.off('open');
      socket.off('close');
      socket.off('error');
      try {
        socket.close().catch((error: BusinessError) => {
        });
      } catch (error) {
      }
    }
    this.emitStatus(false, reason);
  }

  private failConnect(message: string): void {
    this.emitStatus(false, message);
    const reject = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    this.closeSocket(false, '');
    if (reject !== undefined) {
      reject(new Error(message));
    }
  }

  private closeSocket(emitStatus: boolean, message: string): void {
    const socket = this.socket;
    this.socket = undefined;
    this.transportConnected = false;
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.rejectAllPending('连接已断开');
    if (socket !== undefined) {
      socket.off('message');
      socket.off('open');
      socket.off('close');
      socket.off('error');
      try {
        socket.close().catch((error: BusinessError) => {
        });
      } catch (error) {
      }
    }
    if (emitStatus) {
      this.emitStatus(false, message);
    }
  }

  private rejectAllPending(message: string): void {
    this.pending.forEach((call: DshPendingCall) => {
      if (call.timer >= 0) {
        clearTimeout(call.timer);
      }
      call.reject(new Error(message));
    });
    this.pending.clear();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer >= 0) {
      clearTimeout(this.connectTimer);
      this.connectTimer = -1;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transportConnected) {
        return;
      }
      this.sendJson('{"type":"ping"}');
      if (Date.now() - this.lastMessageAt > 70000) {
        this.handleClose('连接超时');
      }
    }, 20000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer >= 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = -1;
    }
  }

  private sendJson(payload: string): void {
    const socket = this.socket;
    if (socket === undefined) {
      return;
    }
    socket.send(payload).catch((error: BusinessError) => {
      this.emitStatus(false, `发送失败：${error.message}`);
    });
  }

  private emit(frame: DshWireFrame): void {
    const snapshot = this.listeners.slice();
    for (let index = 0; index < snapshot.length; index++) {
      try {
        snapshot[index](frame);
      } catch (error) {
        // A listener must not break the socket loop.
      }
    }
  }

  private emitStatus(online: boolean, message: string): void {
    const frame: DshWireFrame = {
      type: 'event',
      event: 'connection.status',
      online: online,
      message: message
    };
    this.emit(frame);
  }

  private emitBridgeStatus(online: boolean, message: string): void {
    const frame: DshWireFrame = {
      type: 'event',
      event: 'bridge.status',
      online: online,
      message: message
    };
    this.emit(frame);
  }

  request(method: string, params: DshRpcParams, timeoutMs: number): Promise<DshRpcPayload> {
    if (!this.transportConnected || this.socket === undefined) {
      return Promise.reject(new Error('尚未连接网关'));
    }
    const id = `rpc-${++this.sequence}`;
    const request: DshRpcRequest = {
      type: 'rpc',
      id: id,
      method: method,
      params: params
    };
    return new Promise<DshRpcPayload>((resolve: (value: DshRpcPayload) => void,
      reject: (reason: Error) => void) => {
      let timer = -1;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('请求超时'));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: resolve,
        reject: reject,
        timer: timer
      });
      this.sendJson(JSON.stringify(request));
    });
  }

  async listSessions(): Promise<DshSessionsResult> {
    const payload = await this.request('sessions.list', {}, 45000);
    const result: DshSessionsResult = {
      sessions: payload.sessions ?? [],
      online: payload.online === true,
      warning: payload.warning ?? ''
    };
    return result;
  }

  async newSession(cwd: string): Promise<DshOpenResult> {
    const payload = await this.request('session.new', { cwd: cwd }, 90000);
    const result: DshOpenResult = {
      session: payload.session ?? DshDefaults.session(),
      items: payload.items ?? [],
      configOptions: payload.configOptions ?? [],
      attached: true,
      warning: payload.warning ?? ''
    };
    return result;
  }

  async openSession(sessionId: string, cwd: string): Promise<DshOpenResult> {
    const payload = await this.request('session.open', {
      sessionId: sessionId,
      cwd: cwd
    }, 90000);
    const result: DshOpenResult = {
      session: payload.session ?? DshDefaults.session(),
      items: payload.items ?? [],
      configOptions: payload.configOptions ?? [],
      attached: payload.attached === true,
      warning: payload.warning ?? ''
    };
    return result;
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const payload = await this.request('session.prompt', {
      sessionId: sessionId,
      text: text
    }, 0);
    return payload.stopReason ?? 'end_turn';
  }

  async cancel(sessionId: string): Promise<void> {
    await this.request('session.cancel', { sessionId: sessionId }, 20000);
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<DshConfigOption[]> {
    const payload = await this.request('session.setConfig', {
      sessionId: sessionId,
      configId: configId,
      value: value
    }, 45000);
    return payload.configOptions ?? [];
  }

  async respondApproval(requestId: string, optionId: string): Promise<void> {
    await this.request('approval.respond', {
      requestId: requestId,
      optionId: optionId
    }, 20000);
  }
}
