declare const ciphertextBrand: unique symbol;
declare const fingerprintBrand: unique symbol;
declare const bearerHashBrand: unique symbol;

/**
 * 暗号化したデバイストークン (`v1.<鍵の ID>.<IV>.<暗号文>`)。平文のトークンを DB に渡さないよう、文字列と型で区別する。
 * 作れるのは、apps/api の暗号化の関数 (`sealDeviceToken`) だけ (ADR-0005)。
 */
export type DeviceTokenCiphertext = string & { readonly [ciphertextBrand]: true };

/** デバイストークンの指紋 (`f1.<HMAC>`)。作れるのは、apps/api の指紋の関数だけ (ADR-0005)。 */
export type DeviceTokenFingerprint = string & { readonly [fingerprintBrand]: true };

/**
 * セッションと中継の資格情報のトークンのハッシュ (SHA-256 の Base64URL)。平文のトークンを DB に渡さないよう、文字列と型で
 * 区別する。作れるのは、apps/api の `hashBearerToken` だけ (ADR-0006)。
 */
export type BearerTokenHash = string & { readonly [bearerHashBrand]: true };
