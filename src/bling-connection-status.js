export const BLING_AUTHORIZATION_ERROR_PATTERN = "invalid[ _]refresh[ _]token|refresh token (has )?expired|invalid_grant|invalid_token|refresh token.*expirad";

export function isBlingAuthorizationFailure(message = "") {
  return new RegExp(BLING_AUTHORIZATION_ERROR_PATTERN, "i").test(String(message));
}

export function withBlingAuthorizationFailure(integration, message) {
  if (!isBlingAuthorizationFailure(message)) return integration;
  return {
    ...integration,
    connected: false,
    reconnectRequired: true,
    connectionError: "A autorizacao do Bling expirou ou foi revogada. Clique em Reconectar no Bling e confirme o acesso. Os envios pendentes foram preservados."
  };
}
