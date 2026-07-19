export interface FeishuTextElement {
  tag: string;
  text?: string;
  user_id?: string;
}

export type FeishuPayload = Record<string, unknown>;

export interface FeishuProviderResult {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
  [key: string]: unknown;
}

export type FeishuSendResult =
  | { success: true; detail: FeishuProviderResult }
  | { success: false; error: string; detail?: FeishuProviderResult; transportError?: boolean };

export interface FeishuNotifierDependencies {
  getWebhookUrl?: () => Promise<string>;
  fetcher?: typeof fetch;
}

export interface FeishuNotifier {
  sendText(text: string): Promise<boolean>;
}
