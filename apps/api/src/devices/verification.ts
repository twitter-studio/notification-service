import type { ApnsEnvironment } from "@notification-service/db";

// 端末がトークンを持っていることの確かめの push (ADR-0008)。APNs へ送る部分は APNS-002 で作る。

export type DeviceVerificationPush = {
  deviceId: string;
  /** 小文字の 16 進数のトークン。ログに出さない。 */
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
  /** アプリが `POST /v1/devices/{id}/verification` で返す code。ログに出さない。 */
  code: string;
};

/** 確かめの push を送る。送れたら true。 */
export type DeviceVerificationSender = (push: DeviceVerificationPush) => Promise<boolean>;

/** APNs へ送る仕組み (APNS-002) がまだないあいだの送り手。送らずに false を返す (端末は確かめないままで、通知は送らない)。 */
export const notConfiguredVerificationSender: DeviceVerificationSender = async () => {
  console.warn(
    JSON.stringify({ event: "device_verification_not_sent", reason: "apns_not_configured" }),
  );
  return false;
};
