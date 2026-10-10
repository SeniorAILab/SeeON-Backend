export class SmtpConfigError extends Error {
  constructor(readonly configName: string) {
    super(`SMTP config is missing: ${configName}`);
  }
}
