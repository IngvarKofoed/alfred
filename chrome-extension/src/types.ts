export interface WebSocketRequest {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

export interface WebSocketResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
