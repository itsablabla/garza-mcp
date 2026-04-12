import nodemailer from 'nodemailer';
import { ProtonMailConfig, SendEmailOptions } from '../types/index.js';
import { parseEmails } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export class SMTPService {
  private transporter: nodemailer.Transporter | null = null;
  private config: ProtonMailConfig;

  constructor(config: ProtonMailConfig) {
    this.config = config;
    this.initTransporter();
  }

  private initTransporter(): void {
    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.username,
        pass: this.config.smtp.password,
      },
      tls: { rejectUnauthorized: false },
    });
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) throw new Error('SMTP transporter not initialized');
    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified', 'SMTPService');
      return true;
    } catch {
      logger.warn('SMTP verification failed (may still work)', 'SMTPService');
      return false;
    }
  }

  async sendEmail(options: SendEmailOptions): Promise<{ messageId: string; accepted: string[] }> {
    if (!this.transporter) throw new Error('SMTP transporter not initialized');

    const toAddresses = parseEmails(options.to);
    const ccAddresses = options.cc ? parseEmails(options.cc) : undefined;
    const bccAddresses = options.bcc ? parseEmails(options.bcc) : undefined;

    const mailOptions: nodemailer.SendMailOptions = {
      from: this.config.smtp.username,
      to: toAddresses.join(', '),
      cc: ccAddresses?.join(', '),
      bcc: bccAddresses?.join(', '),
      subject: options.subject,
      text: options.body,
      html: options.htmlBody,
      replyTo: options.replyTo,
      priority: options.priority,
    };

    if (options.attachments?.length) {
      mailOptions.attachments = options.attachments.map(att => ({
        filename: att.filename,
        content: Buffer.from(att.content, 'base64'),
        contentType: att.contentType,
      }));
    }

    const result = await this.transporter.sendMail(mailOptions);
    logger.info(`Email sent: ${result.messageId}`, 'SMTPService');
    return { messageId: result.messageId, accepted: result.accepted as string[] };
  }

  getStatus(): { connected: boolean; host: string; port: number } {
    return { connected: this.transporter !== null, host: this.config.smtp.host, port: this.config.smtp.port };
  }
}
