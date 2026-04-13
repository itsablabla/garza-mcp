/**
 * Nextcloud Service — Comprehensive Nextcloud integration
 * Combines tools from cbcoutinho/nextcloud-mcp-server, cloud-py-api/nc_mcp_server,
 * Jaypeg-dev/nextcloud-mcp, and others into one unified service.
 *
 * Covers: Notes, Calendar (CalDAV), Contacts (CardDAV), Files (WebDAV),
 * Deck, Cookbook, Tables, Sharing, Talk, Notifications, Activity,
 * Users, User Status, Tasks (CalDAV VTODO), News, Trashbin, Tags, Collectives
 *
 * Auth: Basic Auth (username + app password)
 * Base URL: https://next.garzaos.online (configurable)
 */

import { logger } from '../utils/logger.js';

export class NextcloudService {
  private baseUrl: string;
  private authHeader: string;
  private username: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  }

  // ── HTTP helpers ────────────────────────────────────────────────────

  private async req<T = any>(method: string, path: string, body?: any, extraHeaders?: Record<string, string>, rawResponse?: boolean): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    logger.debug(`Nextcloud ${method} ${url}`, 'Nextcloud');
    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      'OCS-APIRequest': 'true',
      ...(extraHeaders || {}),
    };
    const opts: RequestInit = { method, headers };
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        opts.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;
    try {
      const res = await fetch(url, opts);
      clearTimeout(timeout);
      if (rawResponse) return res as any;
      const text = await res.text();
      if (!res.ok) throw new Error(`Nextcloud API ${res.status} ${method} ${path}: ${text.slice(0, 500)}`);
      if (!text) return {} as T;
      try { return JSON.parse(text); } catch { return text as any; }
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error(`Nextcloud: Request timed out after 30s — ${method} ${path}`);
      throw e;
    }
  }

  private async ocsGet<T = any>(path: string): Promise<T> {
    const data = await this.req<any>('GET', path, undefined, { 'Accept': 'application/json' });
    return data?.ocs?.data ?? data;
  }

  private async ocsPost<T = any>(path: string, body?: any): Promise<T> {
    const data = await this.req<any>('POST', path, body, { 'Accept': 'application/json' });
    return data?.ocs?.data ?? data;
  }

  private async ocsPut<T = any>(path: string, body?: any): Promise<T> {
    const data = await this.req<any>('PUT', path, body, { 'Accept': 'application/json' });
    return data?.ocs?.data ?? data;
  }

  private async ocsDelete<T = any>(path: string): Promise<T> {
    const data = await this.req<any>('DELETE', path, undefined, { 'Accept': 'application/json' });
    return data?.ocs?.data ?? data;
  }

  private async davRequest(method: string, path: string, body?: string, extraHeaders?: Record<string, string>): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    logger.debug(`Nextcloud DAV ${method} ${url}`, 'Nextcloud');
    const headers: Record<string, string> = {
      'Authorization': this.authHeader,
      ...(extraHeaders || {}),
    };
    const opts: RequestInit = { method, headers };
    if (body) opts.body = body;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    opts.signal = controller.signal;
    try {
      const res = await fetch(url, opts);
      clearTimeout(timeout);
      const text = await res.text();
      if (!res.ok && res.status !== 207) throw new Error(`Nextcloud DAV ${res.status}: ${text.slice(0, 500)}`);
      return text;
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error(`Nextcloud DAV: Timed out — ${method} ${path}`);
      throw e;
    }
  }

  // ── XML parsing helpers ─────────────────────────────────────────────

  private extractXmlValues(xml: string, tag: string): string[] {
    const regex = new RegExp(`<(?:[a-z]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`, 'gi');
    const results: string[] = [];
    let m;
    while ((m = regex.exec(xml)) !== null) results.push(m[1].trim());
    return results;
  }

  private extractHrefs(xml: string): string[] {
    return this.extractXmlValues(xml, 'href');
  }

  // ══════════════════════════════════════════════════════════════════════
  // NOTES (Nextcloud Notes API v1)
  // ══════════════════════════════════════════════════════════════════════

  async notesList(category?: string): Promise<any> {
    let path = '/index.php/apps/notes/api/v1/notes';
    if (category) path += `?category=${encodeURIComponent(category)}`;
    return this.req('GET', path, undefined, { 'Accept': 'application/json' });
  }

  async notesGet(noteId: number): Promise<any> {
    return this.req('GET', `/index.php/apps/notes/api/v1/notes/${noteId}`, undefined, { 'Accept': 'application/json' });
  }

  async notesCreate(title: string, content: string, category?: string): Promise<any> {
    return this.req('POST', '/index.php/apps/notes/api/v1/notes', { title, content, category: category || '' }, { 'Accept': 'application/json' });
  }

  async notesUpdate(noteId: number, title?: string, content?: string, category?: string): Promise<any> {
    const body: any = {};
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    if (category !== undefined) body.category = category;
    return this.req('PUT', `/index.php/apps/notes/api/v1/notes/${noteId}`, body, { 'Accept': 'application/json' });
  }

  async notesDelete(noteId: number): Promise<any> {
    return this.req('DELETE', `/index.php/apps/notes/api/v1/notes/${noteId}`, undefined, { 'Accept': 'application/json' });
  }

  async notesSearch(query: string): Promise<any[]> {
    const notes = await this.notesList();
    if (!Array.isArray(notes)) return [];
    const q = query.toLowerCase();
    return notes.filter((n: any) =>
      (n.title || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q) ||
      (n.category || '').toLowerCase().includes(q)
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // CALENDAR (CalDAV via OCS + DAV)
  // ══════════════════════════════════════════════════════════════════════

  async calendarList(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/apps/dav/api/v1/direct');
  }

  async calendarListCalendars(): Promise<any[]> {
    const xml = await this.davRequest('PROPFIND', `/remote.php/dav/calendars/${this.username}/`, undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    const hrefs = this.extractHrefs(xml);
    const names = this.extractXmlValues(xml, 'displayname');
    const results: any[] = [];
    for (let i = 1; i < hrefs.length; i++) {
      const href = hrefs[i];
      if (href.includes('/inbox/') || href.includes('/outbox/') || href.includes('/notifications/')) continue;
      results.push({ href, name: names[i] || href.split('/').filter(Boolean).pop() });
    }
    return results;
  }

  async calendarGetEvents(calendarId?: string, startDate?: string, endDate?: string): Promise<any[]> {
    const calPath = calendarId || 'personal';
    const start = startDate || new Date().toISOString().split('T')[0];
    const end = endDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start.replace(/-/g, '')}T000000Z" end="${end.replace(/-/g, '')}T235959Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
    const xml = await this.davRequest('REPORT', `/remote.php/dav/calendars/${this.username}/${calPath}/`, body, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseCalendarData(xml, 'VEVENT');
  }

  async calendarCreateEvent(summary: string, startDateTime: string, endDateTime: string, calendarId?: string, description?: string, location?: string): Promise<any> {
    const calPath = calendarId || 'personal';
    const uid = crypto.randomUUID();
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const dtStart = startDateTime.replace(/[-:]/g, '').replace(/\.\d+/, '');
    const dtEnd = endDateTime.replace(/[-:]/g, '').replace(/\.\d+/, '');
    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//GarzaMCP//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${now}\r\nDTSTART:${dtStart}\r\nDTEND:${dtEnd}\r\nSUMMARY:${summary}\r\n`;
    if (description) ical += `DESCRIPTION:${description}\r\n`;
    if (location) ical += `LOCATION:${location}\r\n`;
    ical += `END:VEVENT\r\nEND:VCALENDAR`;
    await this.davRequest('PUT', `/remote.php/dav/calendars/${this.username}/${calPath}/${uid}.ics`, ical, { 'Content-Type': 'text/calendar; charset=utf-8' });
    return { uid, summary, start: startDateTime, end: endDateTime, calendar: calPath };
  }

  async calendarDeleteEvent(calendarId: string, eventUid: string): Promise<any> {
    await this.davRequest('DELETE', `/remote.php/dav/calendars/${this.username}/${calendarId}/${eventUid}.ics`);
    return { deleted: true, uid: eventUid };
  }

  // ── Tasks (VTODO via CalDAV) ────────────────────────────────────────

  async taskListLists(): Promise<any[]> {
    const xml = await this.davRequest('PROPFIND', `/remote.php/dav/calendars/${this.username}/`, undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    // Split on both namespaced and non-namespaced response tags
    const comps = xml.split(/<(?:d:|D:)?response>/i);
    const results: any[] = [];
    for (let i = 1; i < comps.length; i++) {
      if (comps[i].includes('VTODO')) {
        const href = this.extractHrefs('<r>' + comps[i])[0] || '';
        const name = this.extractXmlValues('<r>' + comps[i], 'displayname')[0] || '';
        // Skip deck-generated calendars for cleaner task list
        const id = href.split('/').filter(Boolean).pop() || '';
        results.push({ href, name, id });
      }
    }
    return results;
  }

  async taskGetTasks(listId?: string, status?: string): Promise<any[]> {
    const lists = listId ? [{ id: listId }] : await this.taskListLists();
    const allTasks: any[] = [];
    for (const list of lists) {
      const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
      const xml = await this.davRequest('REPORT', `/remote.php/dav/calendars/${this.username}/${list.id}/`, body, { 'Depth': '1', 'Content-Type': 'application/xml' });
      const tasks = this.parseCalendarData(xml, 'VTODO');
      for (const t of tasks) { t.listId = list.id; }
      allTasks.push(...tasks);
    }
    if (status && status !== 'all') {
      return allTasks.filter(t => {
        if (status === 'completed') return t.status === 'COMPLETED' || t.percentComplete === '100';
        if (status === 'open') return t.status !== 'COMPLETED';
        return true;
      });
    }
    return allTasks;
  }

  async taskCreate(summary: string, listId?: string, description?: string, due?: string, priority?: number): Promise<any> {
    // If no listId, find first calendar that supports VTODO
    let calPath = listId;
    if (!calPath) {
      try {
        const lists = await this.taskListLists();
        if (lists.length > 0) calPath = lists[0].href.split('/').filter(Boolean).pop();
      } catch { /* ignore */ }
    }
    if (!calPath) calPath = 'personal';
    const uid = crypto.randomUUID();
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//GarzaMCP//EN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nDTSTAMP:${now}\r\nCREATED:${now}\r\nSUMMARY:${summary}\r\nSTATUS:NEEDS-ACTION\r\n`;
    if (description) ical += `DESCRIPTION:${description}\r\n`;
    if (due) ical += `DUE:${due.replace(/-/g, '')}T000000Z\r\n`;
    if (priority) ical += `PRIORITY:${priority}\r\n`;
    ical += `END:VTODO\r\nEND:VCALENDAR`;
    await this.davRequest('PUT', `/remote.php/dav/calendars/${this.username}/${calPath}/${uid}.ics`, ical, { 'Content-Type': 'text/calendar; charset=utf-8' });
    return { uid, summary, list: calPath };
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONTACTS (CardDAV)
  // ══════════════════════════════════════════════════════════════════════

  async contactsListAddressbooks(): Promise<any[]> {
    const xml = await this.davRequest('PROPFIND', `/remote.php/dav/addressbooks/users/${this.username}/`, undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    const hrefs = this.extractHrefs(xml);
    const names = this.extractXmlValues(xml, 'displayname');
    const results: any[] = [];
    for (let i = 1; i < hrefs.length; i++) {
      results.push({ href: hrefs[i], name: names[i] || hrefs[i].split('/').filter(Boolean).pop() });
    }
    return results;
  }

  async contactsListContacts(addressbookId?: string): Promise<any[]> {
    const abPath = addressbookId || 'contacts';
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
</C:addressbook-query>`;
    const xml = await this.davRequest('REPORT', `/remote.php/dav/addressbooks/users/${this.username}/${abPath}/`, body, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseVCards(xml);
  }

  async contactsCreateContact(addressbookId: string, fullName: string, email?: string, phone?: string, org?: string): Promise<any> {
    const abPath = addressbookId || 'contacts';
    const uid = crypto.randomUUID();
    let vcard = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fullName}\r\nN:${fullName.split(' ').reverse().join(';')};;;\r\n`;
    if (email) vcard += `EMAIL;TYPE=WORK:${email}\r\n`;
    if (phone) vcard += `TEL;TYPE=CELL:${phone}\r\n`;
    if (org) vcard += `ORG:${org}\r\n`;
    vcard += `END:VCARD`;
    await this.davRequest('PUT', `/remote.php/dav/addressbooks/users/${this.username}/${abPath}/${uid}.vcf`, vcard, { 'Content-Type': 'text/vcard; charset=utf-8' });
    return { uid, fullName, email, phone, org, addressbook: abPath };
  }

  async contactsDeleteContact(addressbookId: string, contactUid: string): Promise<any> {
    await this.davRequest('DELETE', `/remote.php/dav/addressbooks/users/${this.username}/${addressbookId}/${contactUid}.vcf`);
    return { deleted: true, uid: contactUid };
  }

  async contactsSearch(query: string): Promise<any[]> {
    const contacts = await this.contactsListContacts();
    const q = query.toLowerCase();
    return contacts.filter((c: any) =>
      (c.fullName || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.org || '').toLowerCase().includes(q)
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // FILES (WebDAV)
  // ══════════════════════════════════════════════════════════════════════

  async filesListDirectory(path?: string): Promise<any[]> {
    const davPath = `/remote.php/dav/files/${this.username}/${(path || '/').replace(/^\//, '')}`;
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <D:prop>
    <D:getlastmodified/><D:getcontentlength/><D:getcontenttype/><D:resourcetype/>
    <oc:fileid/><oc:size/><oc:favorite/>
  </D:prop>
</D:propfind>`;
    const xml = await this.davRequest('PROPFIND', davPath, body, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml).slice(1); // skip the directory itself
  }

  async filesReadFile(path: string): Promise<string> {
    const davPath = `/remote.php/dav/files/${this.username}/${path.replace(/^\//, '')}`;
    return this.davRequest('GET', davPath);
  }

  async filesWriteFile(path: string, content: string): Promise<any> {
    const davPath = `/remote.php/dav/files/${this.username}/${path.replace(/^\//, '')}`;
    await this.davRequest('PUT', davPath, content, { 'Content-Type': 'application/octet-stream' });
    return { written: true, path };
  }

  async filesCreateDirectory(path: string): Promise<any> {
    const davPath = `/remote.php/dav/files/${this.username}/${path.replace(/^\//, '')}`;
    await this.davRequest('MKCOL', davPath);
    return { created: true, path };
  }

  async filesDeleteResource(path: string): Promise<any> {
    const davPath = `/remote.php/dav/files/${this.username}/${path.replace(/^\//, '')}`;
    await this.davRequest('DELETE', davPath);
    return { deleted: true, path };
  }

  async filesMoveResource(source: string, destination: string): Promise<any> {
    const srcPath = `/remote.php/dav/files/${this.username}/${source.replace(/^\//, '')}`;
    const dstPath = `${this.baseUrl}/remote.php/dav/files/${this.username}/${destination.replace(/^\//, '')}`;
    await this.davRequest('MOVE', srcPath, undefined, { 'Destination': dstPath, 'Overwrite': 'F' });
    return { moved: true, from: source, to: destination };
  }

  async filesCopyResource(source: string, destination: string): Promise<any> {
    const srcPath = `/remote.php/dav/files/${this.username}/${source.replace(/^\//, '')}`;
    const dstPath = `${this.baseUrl}/remote.php/dav/files/${this.username}/${destination.replace(/^\//, '')}`;
    await this.davRequest('COPY', srcPath, undefined, { 'Destination': dstPath, 'Overwrite': 'F' });
    return { copied: true, from: source, to: destination };
  }

  async filesSearch(query: string, path?: string): Promise<any[]> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<D:searchrequest xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">
  <D:basicsearch>
    <D:select><D:prop><D:getlastmodified/><D:getcontentlength/><D:getcontenttype/><D:resourcetype/><oc:fileid/></D:prop></D:select>
    <D:from><D:scope><D:href>/files/${this.username}/${(path || '').replace(/^\//, '')}</D:href><D:depth>infinity</D:depth></D:scope></D:from>
    <D:where><D:like><D:prop><D:displayname/></D:prop><D:literal>%${query}%</D:literal></D:like></D:where>
  </D:basicsearch>
</D:searchrequest>`;
    const xml = await this.davRequest('SEARCH', '/remote.php/dav/', body, { 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml);
  }

  async filesListFavorites(): Promise<any[]> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-files xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <D:prop><D:getlastmodified/><D:getcontentlength/><D:getcontenttype/><D:resourcetype/><oc:fileid/></D:prop>
  <oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules>
</oc:filter-files>`;
    const xml = await this.davRequest('REPORT', `/remote.php/dav/files/${this.username}/`, body, { 'Depth': 'infinity', 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml);
  }

  // ══════════════════════════════════════════════════════════════════════
  // TRASHBIN
  // ══════════════════════════════════════════════════════════════════════

  async trashbinList(): Promise<any[]> {
    const xml = await this.davRequest('PROPFIND', `/remote.php/dav/trashbin/${this.username}/trash/`, undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml).slice(1);
  }

  async trashbinRestore(trashPath: string): Promise<any> {
    const dest = `${this.baseUrl}/remote.php/dav/trashbin/${this.username}/restore/${trashPath.split('/').pop()}`;
    await this.davRequest('MOVE', `/remote.php/dav/trashbin/${this.username}/trash/${trashPath.replace(/^\//, '')}`, undefined, { 'Destination': dest, 'Overwrite': 'T' });
    return { restored: true, path: trashPath };
  }

  async trashbinDelete(trashPath: string): Promise<any> {
    await this.davRequest('DELETE', `/remote.php/dav/trashbin/${this.username}/trash/${trashPath.replace(/^\//, '')}`);
    return { deleted: true, path: trashPath };
  }

  async trashbinEmpty(): Promise<any> {
    await this.davRequest('DELETE', `/remote.php/dav/trashbin/${this.username}/trash/`);
    return { emptied: true };
  }

  // ══════════════════════════════════════════════════════════════════════
  // DECK (Kanban boards)
  // ══════════════════════════════════════════════════════════════════════

  async deckListBoards(): Promise<any> {
    return this.req('GET', '/index.php/apps/deck/api/v1.0/boards', undefined, { 'Accept': 'application/json' });
  }

  async deckGetBoard(boardId: number): Promise<any> {
    return this.req('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}`, undefined, { 'Accept': 'application/json' });
  }

  async deckCreateBoard(title: string, color?: string): Promise<any> {
    return this.req('POST', '/index.php/apps/deck/api/v1.0/boards', { title, color: color || '0800fd' }, { 'Accept': 'application/json' });
  }

  async deckDeleteBoard(boardId: number): Promise<any> {
    return this.req('DELETE', `/index.php/apps/deck/api/v1.0/boards/${boardId}`, undefined, { 'Accept': 'application/json' });
  }

  async deckListStacks(boardId: number): Promise<any> {
    return this.req('GET', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`, undefined, { 'Accept': 'application/json' });
  }

  async deckCreateStack(boardId: number, title: string, order?: number): Promise<any> {
    return this.req('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks`, { title, order: order || 0 }, { 'Accept': 'application/json' });
  }

  async deckCreateCard(boardId: number, stackId: number, title: string, description?: string, duedate?: string): Promise<any> {
    const body: any = { title, type: 'plain' };
    if (description) body.description = description;
    if (duedate) body.duedate = duedate;
    return this.req('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards`, body, { 'Accept': 'application/json' });
  }

  async deckUpdateCard(boardId: number, stackId: number, cardId: number, title?: string, description?: string, duedate?: string): Promise<any> {
    const body: any = {};
    if (title) body.title = title;
    if (description !== undefined) body.description = description;
    if (duedate !== undefined) body.duedate = duedate;
    return this.req('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`, body, { 'Accept': 'application/json' });
  }

  async deckDeleteCard(boardId: number, stackId: number, cardId: number): Promise<any> {
    return this.req('DELETE', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}`, undefined, { 'Accept': 'application/json' });
  }

  async deckMoveCard(boardId: number, stackId: number, cardId: number, targetStackId: number): Promise<any> {
    return this.req('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/reorder`, { stackId: targetStackId, order: 0 }, { 'Accept': 'application/json' });
  }

  async deckAssignLabel(boardId: number, stackId: number, cardId: number, labelId: number): Promise<any> {
    return this.req('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignLabel`, { labelId }, { 'Accept': 'application/json' });
  }

  async deckAssignUser(boardId: number, stackId: number, cardId: number, userId: string): Promise<any> {
    return this.req('PUT', `/index.php/apps/deck/api/v1.0/boards/${boardId}/stacks/${stackId}/cards/${cardId}/assignUser`, { userId }, { 'Accept': 'application/json' });
  }

  async deckCreateLabel(boardId: number, title: string, color?: string): Promise<any> {
    return this.req('POST', `/index.php/apps/deck/api/v1.0/boards/${boardId}/labels`, { title, color: color || '31CC7C' }, { 'Accept': 'application/json' });
  }

  // ══════════════════════════════════════════════════════════════════════
  // TABLES (Nextcloud Tables API)
  // ══════════════════════════════════════════════════════════════════════

  async tablesListTables(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/apps/tables/api/2/tables');
  }

  async tablesGetTable(tableId: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/tables/api/2/tables/${tableId}`);
  }

  async tablesGetColumns(tableId: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/tables/api/2/columns/${tableId}?nodeType=table`);
  }

  async tablesGetRows(tableId: number, limit?: number, offset?: number): Promise<any> {
    const body: any = { viewId: null, limit: limit || 50, offset: offset || 0 };
    return this.ocsPost(`/ocs/v2.php/apps/tables/api/2/tables/${tableId}/rows/simple`, body);
  }

  async tablesCreateRow(tableId: number, data: Record<string, any>): Promise<any> {
    return this.ocsPost(`/ocs/v2.php/apps/tables/api/2/tables/${tableId}/rows`, { data: Object.entries(data).map(([columnId, value]) => ({ columnId: parseInt(columnId), value })) });
  }

  async tablesUpdateRow(rowId: number, data: Record<string, any>): Promise<any> {
    return this.ocsPut(`/ocs/v2.php/apps/tables/api/2/rows/${rowId}`, { data: Object.entries(data).map(([columnId, value]) => ({ columnId: parseInt(columnId), value })) });
  }

  async tablesDeleteRow(rowId: number): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/apps/tables/api/2/rows/${rowId}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHARING (OCS Share API)
  // ══════════════════════════════════════════════════════════════════════

  async sharesList(path?: string): Promise<any> {
    const p = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.ocsGet(`/ocs/v2.php/apps/files_sharing/api/v1/shares${p}`);
  }

  async sharesGet(shareId: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`);
  }

  async sharesCreate(path: string, shareType: number, shareWith?: string, permissions?: number, password?: string, expireDate?: string): Promise<any> {
    const body: any = { path, shareType };
    if (shareWith) body.shareWith = shareWith;
    if (permissions !== undefined) body.permissions = permissions;
    if (password) body.password = password;
    if (expireDate) body.expireDate = expireDate;
    return this.ocsPost('/ocs/v2.php/apps/files_sharing/api/v1/shares', body);
  }

  async sharesUpdate(shareId: number, permissions?: number, password?: string, expireDate?: string): Promise<any> {
    const body: any = {};
    if (permissions !== undefined) body.permissions = permissions;
    if (password) body.password = password;
    if (expireDate) body.expireDate = expireDate;
    return this.ocsPut(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`, body);
  }

  async sharesDelete(shareId: number): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // TALK (Spreed)
  // ══════════════════════════════════════════════════════════════════════

  async talkListConversations(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/apps/spreed/api/v4/room');
  }

  async talkGetConversation(token: string): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/spreed/api/v4/room/${token}`);
  }

  async talkCreateConversation(roomType: number, roomName: string, invite?: string): Promise<any> {
    const body: any = { roomType, roomName };
    if (invite) body.invite = invite;
    return this.ocsPost('/ocs/v2.php/apps/spreed/api/v4/room', body);
  }

  async talkGetMessages(token: string, limit?: number, lookIntoFuture?: number): Promise<any> {
    const params = new URLSearchParams({ limit: String(limit || 100), lookIntoFuture: String(lookIntoFuture || 0) });
    return this.ocsGet(`/ocs/v2.php/apps/spreed/api/v1/chat/${token}?${params}`);
  }

  async talkSendMessage(token: string, message: string, replyTo?: number): Promise<any> {
    const body: any = { message };
    if (replyTo) body.replyTo = replyTo;
    return this.ocsPost(`/ocs/v2.php/apps/spreed/api/v1/chat/${token}`, body);
  }

  async talkDeleteMessage(token: string, messageId: number): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/apps/spreed/api/v1/chat/${token}/${messageId}`);
  }

  async talkGetParticipants(token: string): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/spreed/api/v4/room/${token}/participants`);
  }

  async talkCreatePoll(token: string, question: string, options: string[], maxVotes?: number): Promise<any> {
    return this.ocsPost(`/ocs/v2.php/apps/spreed/api/v1/poll/${token}`, { question, options, resultMode: 0, maxVotes: maxVotes || 1 });
  }

  async talkGetPoll(token: string, pollId: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/spreed/api/v1/poll/${token}/${pollId}`);
  }

  async talkVotePoll(token: string, pollId: number, optionIds: number[]): Promise<any> {
    return this.ocsPost(`/ocs/v2.php/apps/spreed/api/v1/poll/${token}/${pollId}`, { optionIds });
  }

  async talkClosePoll(token: string, pollId: number): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/apps/spreed/api/v1/poll/${token}/${pollId}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════

  async notificationsList(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/apps/notifications/api/v2/notifications');
  }

  async notificationsDismiss(notificationId: number): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/apps/notifications/api/v2/notifications/${notificationId}`);
  }

  async notificationsDismissAll(): Promise<any> {
    return this.ocsDelete('/ocs/v2.php/apps/notifications/api/v2/notifications');
  }

  // ══════════════════════════════════════════════════════════════════════
  // ACTIVITY
  // ══════════════════════════════════════════════════════════════════════

  async activityGet(limit?: number, sinceId?: number): Promise<any> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', String(limit));
    if (sinceId) params.append('since', String(sinceId));
    const qs = params.toString();
    return this.ocsGet(`/ocs/v2.php/apps/activity/api/v2/activity${qs ? '?' + qs : ''}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // USERS
  // ══════════════════════════════════════════════════════════════════════

  async usersGetCurrent(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/cloud/user');
  }

  async usersList(search?: string, limit?: number): Promise<any> {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (limit) params.append('limit', String(limit));
    const qs = params.toString();
    return this.ocsGet(`/ocs/v2.php/cloud/users${qs ? '?' + qs : ''}`);
  }

  async usersGet(userId: string): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/cloud/users/${encodeURIComponent(userId)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // USER STATUS
  // ══════════════════════════════════════════════════════════════════════

  async userStatusGet(userId?: string): Promise<any> {
    if (userId) return this.ocsGet(`/ocs/v2.php/apps/user_status/api/v1/statuses/${encodeURIComponent(userId)}`);
    return this.ocsGet('/ocs/v2.php/apps/user_status/api/v1/user_status');
  }

  async userStatusSet(statusType: string, message?: string, icon?: string): Promise<any> {
    const body: any = { statusType };
    if (message) body.message = message;
    if (icon) body.statusIcon = icon;
    return this.ocsPut('/ocs/v2.php/apps/user_status/api/v1/user_status', body);
  }

  async userStatusClear(): Promise<any> {
    return this.ocsDelete('/ocs/v2.php/apps/user_status/api/v1/user_status');
  }

  // ══════════════════════════════════════════════════════════════════════
  // SEARCH
  // ══════════════════════════════════════════════════════════════════════

  async unifiedSearch(providerId: string, query: string, limit?: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/search/providers/${encodeURIComponent(providerId)}/search?term=${encodeURIComponent(query)}&limit=${limit || 20}`);
  }

  async searchProviders(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/search/providers');
  }

  // ══════════════════════════════════════════════════════════════════════
  // MAIL (Nextcloud Mail app)
  // ══════════════════════════════════════════════════════════════════════

  async mailListAccounts(): Promise<any> {
    return this.req('GET', '/index.php/apps/mail/api/accounts', undefined, { 'Accept': 'application/json' });
  }

  async mailListMailboxes(accountId: number): Promise<any> {
    return this.req('GET', `/index.php/apps/mail/api/accounts/${accountId}/mailboxes`, undefined, { 'Accept': 'application/json' });
  }

  async mailListMessages(accountId: number, folderId: string, limit?: number): Promise<any> {
    return this.req('GET', `/index.php/apps/mail/api/accounts/${accountId}/folders/${encodeURIComponent(folderId)}/messages?limit=${limit || 20}`, undefined, { 'Accept': 'application/json' });
  }

  async mailGetMessage(messageId: number): Promise<any> {
    return this.req('GET', `/index.php/apps/mail/api/messages/${messageId}`, undefined, { 'Accept': 'application/json' });
  }

  async mailSend(accountId: number, to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<any> {
    const msg: any = { accountId, to, subject, body, isHtml: false };
    if (cc) msg.cc = cc;
    if (bcc) msg.bcc = bcc;
    return this.req('POST', '/index.php/apps/mail/api/accounts/send', msg, { 'Accept': 'application/json' });
  }

  // ══════════════════════════════════════════════════════════════════════
  // TAGS (System Tags)
  // ══════════════════════════════════════════════════════════════════════

  async tagsList(): Promise<any> {
    const xml = await this.davRequest('PROPFIND', '/remote.php/dav/systemtags/', undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml).slice(1);
  }

  async tagsCreate(name: string, userVisible?: boolean, userAssignable?: boolean): Promise<any> {
    return this.req('POST', '/remote.php/dav/systemtags/', { name, userVisible: userVisible !== false, userAssignable: userAssignable !== false }, { 'Content-Type': 'application/json' });
  }

  async tagsAssign(fileId: number, tagId: number): Promise<any> {
    await this.davRequest('PUT', `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`);
    return { assigned: true, fileId, tagId };
  }

  async tagsUnassign(fileId: number, tagId: number): Promise<any> {
    await this.davRequest('DELETE', `/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`);
    return { unassigned: true, fileId, tagId };
  }

  // ══════════════════════════════════════════════════════════════════════
  // VERSIONS (File Versions)
  // ══════════════════════════════════════════════════════════════════════

  async versionsList(fileId: number): Promise<any[]> {
    const xml = await this.davRequest('PROPFIND', `/remote.php/dav/versions/${this.username}/versions/${fileId}`, undefined, { 'Depth': '1', 'Content-Type': 'application/xml' });
    return this.parseWebDavPropfind(xml).slice(1);
  }

  async versionsRestore(fileId: number, versionId: string): Promise<any> {
    const dest = `${this.baseUrl}/remote.php/dav/versions/${this.username}/restore/target`;
    await this.davRequest('MOVE', `/remote.php/dav/versions/${this.username}/versions/${fileId}/${versionId}`, undefined, { 'Destination': dest });
    return { restored: true, fileId, versionId };
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMMENTS (File Comments)
  // ══════════════════════════════════════════════════════════════════════

  async commentsList(fileId: number): Promise<any> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<oc:filter-comments xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">
  <oc:limit>50</oc:limit>
  <oc:offset>0</oc:offset>
</oc:filter-comments>`;
    const xml = await this.davRequest('REPORT', `/remote.php/dav/comments/files/${fileId}`, body, { 'Content-Type': 'application/xml' });
    return this.extractXmlValues(xml, 'message');
  }

  async commentsAdd(fileId: number, message: string): Promise<any> {
    const body = JSON.stringify({ actorType: 'users', message, verb: 'comment' });
    await this.davRequest('POST', `/remote.php/dav/comments/files/${fileId}`, body, { 'Content-Type': 'application/json' });
    return { added: true, fileId, message };
  }

  // ══════════════════════════════════════════════════════════════════════
  // APPS MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════

  async appsList(filter?: string): Promise<any> {
    const f = filter ? `?filter=${encodeURIComponent(filter)}` : '?filter=enabled';
    return this.ocsGet(`/ocs/v2.php/cloud/apps${f}`);
  }

  async appsGetInfo(appId: string): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/cloud/apps/${encodeURIComponent(appId)}`);
  }

  async appsEnable(appId: string): Promise<any> {
    return this.ocsPost(`/ocs/v2.php/cloud/apps/${encodeURIComponent(appId)}`);
  }

  async appsDisable(appId: string): Promise<any> {
    return this.ocsDelete(`/ocs/v2.php/cloud/apps/${encodeURIComponent(appId)}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // FORMS
  // ══════════════════════════════════════════════════════════════════════

  async formsList(): Promise<any> {
    return this.ocsGet('/ocs/v2.php/apps/forms/api/v3/forms');
  }

  async formsGet(formId: number): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/forms/api/v3/forms/${formId}`);
  }

  async formsGetSubmissions(formHash: string): Promise<any> {
    return this.ocsGet(`/ocs/v2.php/apps/forms/api/v3/submissions/${formHash}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Internal parsing helpers
  // ══════════════════════════════════════════════════════════════════════

  private parseCalendarData(xml: string, componentType: string): any[] {
    const results: any[] = [];
    const calDataBlocks = this.extractXmlValues(xml, 'calendar-data');
    for (const block of calDataBlocks) {
      const entry: any = {};
      const lines = block.split(/\r?\n/);
      let inComponent = false;
      for (const line of lines) {
        if (line.startsWith(`BEGIN:${componentType}`)) { inComponent = true; continue; }
        if (line.startsWith(`END:${componentType}`)) { inComponent = false; continue; }
        if (!inComponent) continue;
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        let key = line.substring(0, colonIdx).split(';')[0].toLowerCase();
        const val = line.substring(colonIdx + 1);
        if (['uid', 'summary', 'description', 'location', 'dtstart', 'dtend', 'due', 'status', 'priority', 'percent-complete', 'categories', 'created'].includes(key)) {
          if (key === 'percent-complete') key = 'percentComplete';
          entry[key] = val;
        }
      }
      if (Object.keys(entry).length > 0) results.push(entry);
    }
    return results;
  }

  private parseVCards(xml: string): any[] {
    const results: any[] = [];
    const vcardBlocks = this.extractXmlValues(xml, 'address-data');
    for (const block of vcardBlocks) {
      const contact: any = {};
      const lines = block.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('FN:')) contact.fullName = line.substring(3);
        else if (line.startsWith('UID:')) contact.uid = line.substring(4);
        else if (line.includes('EMAIL')) { const v = line.split(':').pop(); if (v) contact.email = v; }
        else if (line.includes('TEL')) { const v = line.split(':').pop(); if (v) contact.phone = v; }
        else if (line.startsWith('ORG:')) contact.org = line.substring(4);
        else if (line.startsWith('TITLE:')) contact.title = line.substring(6);
        else if (line.startsWith('NOTE:')) contact.note = line.substring(5);
      }
      if (contact.fullName || contact.uid) results.push(contact);
    }
    return results;
  }

  private parseWebDavPropfind(xml: string): any[] {
    const results: any[] = [];
    const responses = xml.split(/<(?:D:|d:)?response>/i).slice(1);
    for (const resp of responses) {
      const entry: any = {};
      const hrefs = this.extractHrefs('<r>' + resp);
      entry.href = hrefs[0] || '';
      entry.name = decodeURIComponent(entry.href.split('/').filter(Boolean).pop() || '');

      const lastmod = this.extractXmlValues(resp, 'getlastmodified');
      if (lastmod[0]) entry.lastModified = lastmod[0];

      const size = this.extractXmlValues(resp, 'getcontentlength');
      if (size[0]) entry.size = parseInt(size[0]);

      const type = this.extractXmlValues(resp, 'getcontenttype');
      if (type[0]) entry.contentType = type[0];

      const fileId = this.extractXmlValues(resp, 'fileid');
      if (fileId[0]) entry.fileId = parseInt(fileId[0]);

      const ocSize = this.extractXmlValues(resp, 'size');
      if (ocSize[0] && !entry.size) entry.size = parseInt(ocSize[0]);

      entry.isDirectory = resp.includes('<d:collection') || resp.includes('<D:collection') || resp.includes(':collection');
      const fav = this.extractXmlValues(resp, 'favorite');
      if (fav[0]) entry.favorite = fav[0] === '1';

      results.push(entry);
    }
    return results;
  }
}
