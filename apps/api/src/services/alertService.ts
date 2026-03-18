import type { FastifyBaseLogger } from 'fastify';
import {
  ALERT_WEBHOOK,
  ALERT_TYPE,
  type AlertLevel,
} from '../context.js';

export function resolveAlertType(webhookUrl: string): 'wecom' | 'generic' {
  if (ALERT_TYPE === 'wecom') return 'wecom';
  if (ALERT_TYPE === 'webhook') return 'generic';
  if (webhookUrl.includes('qyapi.weixin.qq.com/cgi-bin/webhook/send')) return 'wecom';
  return 'generic';
}

export function formatAlertTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export async function sendAlert(title: string, lines: string[], level: AlertLevel = 'info', log?: FastifyBaseLogger): Promise<void> {
  if (!ALERT_WEBHOOK) return;

  const alertType = resolveAlertType(ALERT_WEBHOOK);
  const timestamp = formatAlertTimestamp();
  const colorByLevel: Record<AlertLevel, string> = {
    info: 'info',
    warning: 'warning',
    error: 'warning',
  };
  const iconByLevel: Record<AlertLevel, string> = {
    info: '✅',
    warning: '⚠️',
    error: '❌',
  };

  try {
    if (alertType === 'wecom') {
      const content = [
        `<font color="${colorByLevel[level]}">${iconByLevel[level]} ${title}</font>`,
        `时间: ${timestamp}`,
        ...lines,
      ].join('\n');
      const resp = await fetch(ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content },
        }),
      });
      if (!resp.ok) {
        log?.warn(`企业微信通知失败: ${resp.status} ${resp.statusText}`);
      }
      return;
    }

    const resp = await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        level,
        time: timestamp,
        lines,
      }),
    });
    if (!resp.ok) {
      log?.warn(`Webhook 通知失败: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    log?.warn(`通知发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
