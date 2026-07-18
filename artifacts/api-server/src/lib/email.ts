import { logger } from "./logger";

type SendEmailParams = {
  to: string;
  subject: string;
  html: string;
};

// UniSender sendEmail returns one of two successful result shapes:
//   New format (error_checking=1): { result: [{ email: "...", id: "msg-id" }] }
//   Old compat format:             { result: { email_id: 14362456134 } }
type UniSenderResultItem = {
  email?: string;
  id?: string;
  errors?: Array<{ code?: string; message?: string }>;
};

type UniSenderResponse = {
  result?: UniSenderResultItem[] | { email_id?: string | number };
  error?: string;
  code?: string;
};

function maskEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

export async function sendEmail({ to, subject, html }: SendEmailParams): Promise<void> {
  const apiKey = process.env.UNISENDER_API_KEY;
  const senderEmail = process.env.UNISENDER_FROM_EMAIL || "info@platformaekspertov.ru";
  const senderName = process.env.UNISENDER_FROM_NAME || "Платформа судебных экспертов";
  const listId = process.env.UNISENDER_LIST_ID;

  // Explicit config errors — do not silently skip
  if (!apiKey) {
    throw new Error("CONFIG_ERROR: UNISENDER_API_KEY is not set");
  }
  if (!listId) {
    throw new Error("CONFIG_ERROR: UNISENDER_LIST_ID is not set");
  }

  const maskedTo = maskEmail(to);

  const form = new URLSearchParams({
    api_key: apiKey,
    email: to,
    sender_email: senderEmail,
    sender_name: senderName,
    subject,
    body: html,
    list_id: listId,
    lang: "ru",
    error_checking: "1",
    track_read: "0",
    track_links: "0",
  });

  logger.info({ to: maskedTo, subject }, "[EMAIL] verification request started");

  let response: Response;
  try {
    response = await fetch("https://api.unisender.com/ru/api/sendEmail?format=json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (fetchErr) {
    logger.error({ err: fetchErr, to: maskedTo }, "[EMAIL] network error reaching UniSender");
    throw new Error(`UniSender network error: ${(fetchErr as Error).message}`);
  }

  let data: UniSenderResponse | null = null;
  try {
    data = (await response.json()) as UniSenderResponse;
  } catch {
    logger.error(
      { httpStatus: response.status, to: maskedTo },
      "[EMAIL] UniSender returned non-JSON body"
    );
    throw new Error(`UniSender HTTP ${response.status}: non-JSON response`);
  }

  const resultFormat = Array.isArray(data?.result)
    ? "array"
    : data?.result && typeof data.result === "object"
    ? "object"
    : "none";

  logger.info(
    {
      httpStatus: response.status,
      unisenderError: data?.error,
      unisenderCode: data?.code,
      resultFormat,
      to: maskedTo,
    },
    "[EMAIL] UniSender response received"
  );

  if (!response.ok) {
    throw new Error(
      `UniSender HTTP error: ${response.status} — ${data?.error ?? "unknown"}`
    );
  }

  if (!data) throw new Error("UniSender returned empty response");

  if (data.error) {
    throw new Error(`UniSender error [${data.code ?? "?"}]: ${data.error}`);
  }

  if (Array.isArray(data.result)) {
    // New format: result is an array of per-recipient statuses
    const item = data.result[0] as UniSenderResultItem | undefined;

    if (item?.errors?.length) {
      const msg = item.errors
        .map((e) => e.message || e.code || "unknown")
        .join("; ");
      logger.error(
        { recipientErrors: item.errors, to: maskedTo },
        "[EMAIL] UniSender rejected recipient"
      );
      throw new Error(`UniSender rejected recipient: ${msg}`);
    }

    if (!item?.id) {
      logger.error(
        { resultItem: item, to: maskedTo },
        "[EMAIL] UniSender array result missing id"
      );
      throw new Error("UniSender did not return email id (array format)");
    }

    logger.info({ emailId: item.id, to: maskedTo }, "[EMAIL] verification accepted (new format)");
  } else if (data.result && typeof data.result === "object") {
    // Old compat format: result is { email_id: number | string }
    const emailId = (data.result as { email_id?: string | number }).email_id;

    if (emailId === undefined || emailId === null) {
      logger.error(
        { result: data.result, to: maskedTo },
        "[EMAIL] UniSender object result missing email_id"
      );
      throw new Error("UniSender did not return email_id (legacy format)");
    }

    logger.info({ emailId, to: maskedTo }, "[EMAIL] verification accepted (legacy format)");
  } else {
    logger.error(
      { result: data.result, to: maskedTo },
      "[EMAIL] UniSender returned unrecognised result format"
    );
    throw new Error("UniSender returned unrecognised result format");
  }
}

export async function sendVerificationEmail(params: {
  to: string;
  verificationUrl: string;
}): Promise<void> {
  const { to, verificationUrl } = params;
  await sendEmail({
    to,
    subject: "Подтверждение регистрации",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #17213c;">
        <h2>Подтвердите регистрацию</h2>
        <p>Вы зарегистрировались на платформе судебных экспертов.
        Для активации аккаунта подтвердите адрес электронной почты.</p>
        <p style="margin: 28px 0;">
          <a href="${verificationUrl}"
            style="display:inline-block;padding:12px 22px;border-radius:6px;background:#97257f;color:#fff;text-decoration:none;font-weight:700;">
            Подтвердить email
          </a>
        </p>
        <p style="font-size:13px;color:#667085;">Ссылка действует 24 часа.</p>
        <p style="font-size:13px;color:#667085;">Если вы не регистрировались на платформе, просто проигнорируйте это письмо.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
}): Promise<void> {
  const { to, resetUrl } = params;
  await sendEmail({
    to,
    subject: "Сброс пароля",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #17213c;">
        <h2>Сброс пароля</h2>
        <p>Вы запросили сброс пароля. Нажмите кнопку ниже для продолжения.</p>
        <p style="margin: 28px 0;">
          <a href="${resetUrl}"
            style="display:inline-block;padding:12px 22px;border-radius:6px;background:#97257f;color:#fff;text-decoration:none;font-weight:700;">
            Сбросить пароль
          </a>
        </p>
        <p style="font-size:13px;color:#667085;">Ссылка действует 1 час.</p>
        <p style="font-size:13px;color:#667085;">Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>
      </div>
    `,
  });
}
