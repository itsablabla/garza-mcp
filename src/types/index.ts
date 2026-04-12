export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface IMAPConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export interface ProtonMailConfig {
  smtp: SMTPConfig;
  imap: IMAPConfig;
  debug: boolean;
}

export interface ProtonDriveConfig {
  basePath: string;
  debug: boolean;
}

export interface UnifiedConfig {
  mail: ProtonMailConfig;
  drive: ProtonDriveConfig;
  debug: boolean;
}

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType?: string;
  }>;
  replyTo?: string;
  priority?: 'high' | 'normal' | 'low';
}

export interface EmailMessage {
  id: string;
  messageId?: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  date: Date;
  body: string;
  htmlBody?: string;
  folder: string;
  read: boolean;
  starred: boolean;
}

export interface DriveItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  created: string;
}
