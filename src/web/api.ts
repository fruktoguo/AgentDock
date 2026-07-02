/** 轻量 fetch 封装：失败时读取后端 `{ error }` 文本。 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
