import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';

const PREFS_NAME: string = 'dsh_remote_preferences';
const SERVER_KEY: string = 'server_url';
const TOKEN_ALIAS: string = 'dsh_remote_token';

export class DshCredentials {
  private static contextValue: common.UIAbilityContext | undefined = undefined;
  private static store: preferences.Preferences | undefined = undefined;

  static init(context: common.UIAbilityContext): void {
    DshCredentials.contextValue = context;
  }

  private static async getStore(): Promise<preferences.Preferences> {
    if (DshCredentials.store !== undefined) {
      return DshCredentials.store;
    }
    const context = DshCredentials.contextValue;
    if (context === undefined) {
      throw new Error('凭据存储尚未初始化');
    }
    const store = await preferences.getPreferences(context, PREFS_NAME);
    DshCredentials.store = store;
    return store;
  }

  static async loadServerUrl(): Promise<string> {
    try {
      const store = await DshCredentials.getStore();
      const value = await store.get(SERVER_KEY, '');
      return typeof value === 'string' ? value : '';
    } catch (error) {
      return '';
    }
  }

  static async saveServerUrl(url: string): Promise<void> {
    try {
      const store = await DshCredentials.getStore();
      await store.put(SERVER_KEY, url);
      await store.flush();
    } catch (error) {
      // Persisting the address is best effort.
    }
  }

  private static encode(value: string): Uint8Array {
    const encoder = util.TextEncoder.create('utf-8');
    return encoder.encodeInto(value);
  }

  private static decode(value: Uint8Array): string {
    const decoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(value);
  }

  private static aliasValue(): Uint8Array {
    return DshCredentials.encode(TOKEN_ALIAS);
  }

  static async loadToken(): Promise<string> {
    try {
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, DshCredentials.aliasValue());
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const results = await asset.query(query);
      if (results.length === 0) {
        return '';
      }
      const secret = results[0].get(asset.Tag.SECRET);
      if (secret instanceof Uint8Array) {
        return DshCredentials.decode(secret);
      }
      return '';
    } catch (error) {
      return '';
    }
  }

  static async saveToken(token: string): Promise<void> {
    try {
      const removeQuery: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      removeQuery.set(asset.Tag.ALIAS, DshCredentials.aliasValue());
      try {
        await asset.remove(removeQuery);
      } catch (error) {
        // A missing asset is expected on first launch.
      }
      const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      attributes.set(asset.Tag.ALIAS, DshCredentials.aliasValue());
      attributes.set(asset.Tag.SECRET, DshCredentials.encode(token));
      attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
      await asset.add(attributes);
    } catch (error) {
      // The user can re-enter the token when the asset service is unavailable.
    }
  }

  static async clearToken(): Promise<void> {
    try {
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, DshCredentials.aliasValue());
      await asset.remove(query);
    } catch (error) {
      // Nothing to clear.
    }
  }
}
