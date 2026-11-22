export function connectorLine(input: {
  host: string;
  port: number;
  token: string;
  publicUrl?: string;
}): string {
  const base = input.publicUrl
    ? input.publicUrl.replace(/\/$/, "")
    : `http://${input.host === "0.0.0.0" || input.host === "::" ? "127.0.0.1" : input.host}:${input.port}`;
  return JSON.stringify({
    url: `${base}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  });
}
