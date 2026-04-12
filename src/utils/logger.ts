interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: string;
}

class Logger {
  private debugMode = false;
  private logs: LogEntry[] = [];

  setDebugMode(debug: boolean): void {
    this.debugMode = debug;
  }

  debug(message: string, context?: string): void {
    if (this.debugMode) console.error(`[DEBUG] [${context || 'App'}] ${message}`);
    this.addLog('debug', message, context);
  }

  info(message: string, context?: string): void {
    console.error(`[INFO] [${context || 'App'}] ${message}`);
    this.addLog('info', message, context);
  }

  warn(message: string, context?: string): void {
    console.error(`[WARN] [${context || 'App'}] ${message}`);
    this.addLog('warn', message, context);
  }

  error(message: string, context?: string): void {
    console.error(`[ERROR] [${context || 'App'}] ${message}`);
    this.addLog('error', message, context);
  }

  getLogs(level?: string, limit = 100): LogEntry[] {
    const filtered = level ? this.logs.filter(l => l.level === level) : this.logs;
    return filtered.slice(-limit);
  }

  private addLog(level: LogEntry['level'], message: string, context?: string): void {
    this.logs.push({ timestamp: new Date(), level, message, context });
    if (this.logs.length > 1000) this.logs.shift();
  }
}

export const logger = new Logger();
