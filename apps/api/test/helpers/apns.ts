export async function signingConfiguration() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("P256 key pair expected");
  const bytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(bytes instanceof ArrayBuffer)) throw new Error("PKCS8 expected");
  const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const configuration = {
    environment: "sandbox",
    topic: "com.twitter-studio.Tweetbot",
    key_id: "TESTKEY001",
    team_id: "TESTTEAM01",
    private_key: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`,
  };
  return { json: JSON.stringify([configuration]), configuration, publicKey: pair.publicKey };
}
