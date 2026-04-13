"""Nextcloud unified client — WebDAV, CalDAV, CardDAV, OCS API.

Covers 16 Nextcloud apps: Notes, Calendar, Tasks, Contacts, Files, Deck,
Tables, Sharing, Talk, Notifications, Activity, Users, Status, Search,
Mail, Tags, Versions, Comments, Apps, Forms, Trashbin.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any
from xml.sax.saxutils import escape as escape_xml

import httpx

from garza_mcp.config import NEXTCLOUD_PASSWORD, NEXTCLOUD_URL, NEXTCLOUD_USERNAME

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0


class NextcloudService:
    """Async Nextcloud client covering all supported apps."""

    def __init__(
        self,
        url: str = NEXTCLOUD_URL,
        username: str = NEXTCLOUD_USERNAME,
        password: str = NEXTCLOUD_PASSWORD,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.url = url.rstrip("/")
        self.username = username
        self._client = httpx.AsyncClient(
            base_url=self.url,
            auth=(username, password),
            timeout=timeout,
            headers={"OCS-APIRequest": "true"},
        )

    async def close(self) -> None:
        await self._client.aclose()

    # ══════════════════════════════════════════════════════════════════════
    # Internal helpers
    # ══════════════════════════════════════════════════════════════════════

    async def _ocs_get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        p = dict(params or {})
        p["format"] = "json"
        resp = await self._client.get(path, params=p)
        resp.raise_for_status()
        data = resp.json()
        return data.get("ocs", {}).get("data", data)

    async def _ocs_post(self, path: str, data: dict[str, Any] | None = None) -> Any:
        resp = await self._client.post(path, json=data, params={"format": "json"})
        resp.raise_for_status()
        d = resp.json()
        return d.get("ocs", {}).get("data", d)

    async def _ocs_put(self, path: str, data: dict[str, Any] | None = None) -> Any:
        resp = await self._client.put(path, json=data, params={"format": "json"})
        resp.raise_for_status()
        d = resp.json()
        return d.get("ocs", {}).get("data", d)

    async def _ocs_delete(self, path: str) -> Any:
        resp = await self._client.delete(path, params={"format": "json"})
        resp.raise_for_status()
        if resp.content:
            d = resp.json()
            return d.get("ocs", {}).get("data", d)
        return {"status": "deleted"}

    async def _dav_request(self, method: str, path: str, body: str | None = None, **kwargs: Any) -> str:
        headers = dict(kwargs.pop("headers", {}))
        headers["Content-Type"] = "application/xml; charset=utf-8"
        resp = await self._client.request(method, path, content=body, headers=headers, **kwargs)
        resp.raise_for_status()
        return resp.text

    @staticmethod
    def _extract_xml_values(xml: str, tag: str) -> list[str]:
        pattern = rf"<(?:[a-zA-Z0-9_-]+:)?{re.escape(tag)}>([^<]*)</(?:[a-zA-Z0-9_-]+:)?{re.escape(tag)}>"
        return re.findall(pattern, xml, re.DOTALL)

    @staticmethod
    def _extract_hrefs(xml: str) -> list[str]:
        return re.findall(r"<(?:D:|d:)?href>([^<]+)</(?:D:|d:)?href>", xml, re.IGNORECASE)

    # ══════════════════════════════════════════════════════════════════════
    # Notes
    # ══════════════════════════════════════════════════════════════════════

    async def notes_list(self, category: str | None = None) -> Any:
        params: dict[str, Any] = {}
        if category:
            params["category"] = category
        resp = await self._client.get("/apps/notes/api/v1/notes", params=params)
        resp.raise_for_status()
        return resp.json()

    async def notes_get(self, note_id: int) -> Any:
        resp = await self._client.get(f"/apps/notes/api/v1/notes/{note_id}")
        resp.raise_for_status()
        return resp.json()

    async def notes_create(self, title: str, content: str, category: str | None = None) -> Any:
        body: dict[str, Any] = {"title": title, "content": content}
        if category:
            body["category"] = category
        resp = await self._client.post("/apps/notes/api/v1/notes", json=body)
        resp.raise_for_status()
        return resp.json()

    async def notes_update(
        self, note_id: int, title: str | None = None, content: str | None = None, category: str | None = None
    ) -> Any:
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if content is not None:
            body["content"] = content
        if category is not None:
            body["category"] = category
        resp = await self._client.put(f"/apps/notes/api/v1/notes/{note_id}", json=body)
        resp.raise_for_status()
        return resp.json()

    async def notes_delete(self, note_id: int) -> Any:
        resp = await self._client.delete(f"/apps/notes/api/v1/notes/{note_id}")
        resp.raise_for_status()
        return {"status": "deleted", "noteId": note_id}

    async def notes_search(self, query: str) -> Any:
        all_notes = await self.notes_list()
        q = query.lower()
        return [n for n in all_notes if q in str(n.get("title", "")).lower() or q in str(n.get("content", "")).lower()]

    # ══════════════════════════════════════════════════════════════════════
    # Calendar (CalDAV)
    # ══════════════════════════════════════════════════════════════════════

    async def calendar_list(self) -> list[dict[str, Any]]:
        xml = await self._dav_request(
            "PROPFIND",
            f"/remote.php/dav/calendars/{self.username}/",
            body='<?xml version="1.0" encoding="UTF-8"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:cs="urn:ietf:params:xml:ns:caldav" xmlns:cal="http://apple.com/ns/ical/">'
            "<d:prop><d:displayname/><d:resourcetype/><cs:supported-calendar-component-set/><cal:calendar-color/></d:prop>"
            "</d:propfind>",
            headers={"Depth": "1"},
        )
        hrefs = self._extract_hrefs(xml)
        names = self._extract_xml_values(xml, "displayname")
        calendars: list[dict[str, Any]] = []
        for i, href in enumerate(hrefs[1:], start=0):  # skip the collection itself
            cal_id = href.rstrip("/").split("/")[-1]
            calendars.append({
                "id": cal_id,
                "href": href,
                "name": names[i + 1] if i + 1 < len(names) else cal_id,
                "supportsVTODO": "VTODO" in xml.split(href.split("/")[-2])[0] if href.split("/")[-2] in xml else False,
            })
        return calendars

    async def calendar_get_events(
        self, calendar_id: str | None = None, start_date: str | None = None, end_date: str | None = None
    ) -> list[dict[str, Any]]:
        cal = calendar_id or "personal"
        time_range = ""
        if start_date and end_date:
            time_range = f'<C:time-range start="{start_date}" end="{end_date}"/>'
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            "<D:prop><D:getetag/><C:calendar-data/></D:prop>"
            f"<C:filter><C:comp-filter name=\"VCALENDAR\"><C:comp-filter name=\"VEVENT\">{time_range}</C:comp-filter></C:comp-filter></C:filter>"
            "</C:calendar-query>"
        )
        xml = await self._dav_request(
            "REPORT", f"/remote.php/dav/calendars/{self.username}/{cal}/", body=body, headers={"Depth": "1"}
        )
        return self._parse_calendar_data(xml, "VEVENT")

    async def calendar_create_event(
        self,
        summary: str,
        start: str,
        end: str,
        calendar_id: str | None = None,
        description: str | None = None,
        location: str | None = None,
    ) -> dict[str, Any]:
        cal = calendar_id or "personal"
        uid = str(uuid.uuid4())
        desc = f"DESCRIPTION:{description}\r\n" if description else ""
        loc = f"LOCATION:{location}\r\n" if location else ""
        ical = (
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//GarzaMCP//EN\r\n"
            f"BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:{start}\r\nDTEND:{end}\r\n"
            f"SUMMARY:{summary}\r\n{desc}{loc}END:VEVENT\r\nEND:VCALENDAR"
        )
        resp = await self._client.put(
            f"/remote.php/dav/calendars/{self.username}/{cal}/{uid}.ics",
            content=ical,
            headers={"Content-Type": "text/calendar; charset=utf-8"},
        )
        resp.raise_for_status()
        return {"uid": uid, "status": "created", "calendar": cal}

    async def calendar_delete_event(self, calendar_id: str, event_uid: str) -> dict[str, str]:
        resp = await self._client.delete(
            f"/remote.php/dav/calendars/{self.username}/{calendar_id}/{event_uid}.ics"
        )
        resp.raise_for_status()
        return {"status": "deleted", "uid": event_uid}

    # ══════════════════════════════════════════════════════════════════════
    # Tasks (CalDAV VTODO)
    # ══════════════════════════════════════════════════════════════════════

    async def task_list_lists(self) -> list[dict[str, Any]]:
        """List calendars that support VTODO."""
        calendars = await self.calendar_list()
        # Also do a direct check for VTODO support
        result: list[dict[str, Any]] = []
        for cal in calendars:
            # Try to query VTODO
            try:
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
                    "<D:prop><D:getetag/></D:prop>"
                    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter>'
                    "</C:calendar-query>"
                )
                await self._dav_request(
                    "REPORT",
                    f"/remote.php/dav/calendars/{self.username}/{cal['id']}/",
                    body=body,
                    headers={"Depth": "1"},
                )
                result.append(cal)
            except Exception:
                continue
        return result

    async def task_get_tasks(self, list_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        # Find a VTODO-capable calendar
        if list_id:
            cal = list_id
        else:
            lists = await self.task_list_lists()
            cal = lists[0]["id"] if lists else "personal"

        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            "<D:prop><D:getetag/><C:calendar-data/></D:prop>"
            '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter>'
            "</C:calendar-query>"
        )
        xml = await self._dav_request(
            "REPORT", f"/remote.php/dav/calendars/{self.username}/{cal}/", body=body, headers={"Depth": "1"}
        )
        tasks = self._parse_calendar_data(xml, "VTODO")
        if status:
            tasks = [t for t in tasks if t.get("status", "").upper() == status.upper()]
        return tasks

    async def task_create(
        self,
        summary: str,
        list_id: str | None = None,
        description: str | None = None,
        due: str | None = None,
        priority: int | None = None,
    ) -> dict[str, Any]:
        # Auto-detect VTODO-capable calendar
        if list_id:
            cal = list_id
        else:
            lists = await self.task_list_lists()
            cal = lists[0]["id"] if lists else "personal"

        uid = str(uuid.uuid4())
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//GarzaMCP//EN",
            "BEGIN:VTODO",
            f"UID:{uid}",
            f"SUMMARY:{summary}",
        ]
        if description:
            lines.append(f"DESCRIPTION:{description}")
        if due:
            lines.append(f"DUE:{due}")
        if priority is not None:
            lines.append(f"PRIORITY:{priority}")
        lines.extend(["STATUS:NEEDS-ACTION", "END:VTODO", "END:VCALENDAR"])

        resp = await self._client.put(
            f"/remote.php/dav/calendars/{self.username}/{cal}/{uid}.ics",
            content="\r\n".join(lines),
            headers={"Content-Type": "text/calendar; charset=utf-8"},
        )
        resp.raise_for_status()
        return {"uid": uid, "status": "created", "calendar": cal}

    # ══════════════════════════════════════════════════════════════════════
    # Contacts (CardDAV)
    # ══════════════════════════════════════════════════════════════════════

    async def contacts_list_addressbooks(self) -> list[dict[str, Any]]:
        xml = await self._dav_request(
            "PROPFIND",
            f"/remote.php/dav/addressbooks/users/{self.username}/",
            body='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
            headers={"Depth": "1"},
        )
        hrefs = self._extract_hrefs(xml)
        names = self._extract_xml_values(xml, "displayname")
        books: list[dict[str, Any]] = []
        for i, href in enumerate(hrefs[1:], start=0):
            book_id = href.rstrip("/").split("/")[-1]
            books.append({"id": book_id, "href": href, "name": names[i + 1] if i + 1 < len(names) else book_id})
        return books

    async def contacts_list(self, addressbook_id: str | None = None) -> list[dict[str, Any]]:
        book = addressbook_id or "contacts"
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">'
            "<D:prop><D:getetag/><C:address-data/></D:prop>"
            "</C:addressbook-query>"
        )
        xml = await self._dav_request(
            "REPORT",
            f"/remote.php/dav/addressbooks/users/{self.username}/{book}/",
            body=body,
            headers={"Depth": "1"},
        )
        return self._parse_vcards(xml)

    async def contacts_create(
        self,
        addressbook_id: str = "contacts",
        full_name: str = "",
        email_addr: str | None = None,
        phone: str | None = None,
        org: str | None = None,
    ) -> dict[str, Any]:
        uid = str(uuid.uuid4())
        lines = ["BEGIN:VCARD", "VERSION:3.0", f"UID:{uid}", f"FN:{full_name}", f"N:;{full_name};;;"]
        if email_addr:
            lines.append(f"EMAIL;TYPE=INTERNET:{email_addr}")
        if phone:
            lines.append(f"TEL;TYPE=CELL:{phone}")
        if org:
            lines.append(f"ORG:{org}")
        lines.append("END:VCARD")

        resp = await self._client.put(
            f"/remote.php/dav/addressbooks/users/{self.username}/{addressbook_id}/{uid}.vcf",
            content="\n".join(lines),
            headers={"Content-Type": "text/vcard; charset=utf-8"},
        )
        resp.raise_for_status()
        return {"uid": uid, "status": "created"}

    async def contacts_delete(self, addressbook_id: str, contact_uid: str) -> dict[str, str]:
        resp = await self._client.delete(
            f"/remote.php/dav/addressbooks/users/{self.username}/{addressbook_id}/{contact_uid}.vcf"
        )
        resp.raise_for_status()
        return {"status": "deleted", "uid": contact_uid}

    async def contacts_search(self, query: str) -> list[dict[str, Any]]:
        contacts = await self.contacts_list()
        q = query.lower()
        return [
            c
            for c in contacts
            if q in str(c.get("fullName", "")).lower()
            or q in str(c.get("email", "")).lower()
            or q in str(c.get("phone", "")).lower()
        ]

    # ══════════════════════════════════════════════════════════════════════
    # Files (WebDAV)
    # ══════════════════════════════════════════════════════════════════════

    async def files_list(self, path: str | None = None) -> list[dict[str, Any]]:
        p = (path or "/").strip("/")
        xml = await self._dav_request(
            "PROPFIND",
            f"/remote.php/dav/files/{self.username}/{p}",
            body='<?xml version="1.0" encoding="UTF-8"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">'
            "<d:prop><d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/>"
            "<oc:fileid/><oc:size/><oc:favorite/></d:prop></d:propfind>",
            headers={"Depth": "1"},
        )
        return self._parse_webdav_propfind(xml)

    async def files_read(self, path: str) -> str:
        resp = await self._client.get(f"/remote.php/dav/files/{self.username}/{path.strip('/')}")
        resp.raise_for_status()
        return resp.text

    async def files_write(self, path: str, content: str) -> dict[str, str]:
        resp = await self._client.put(
            f"/remote.php/dav/files/{self.username}/{path.strip('/')}",
            content=content.encode(),
        )
        resp.raise_for_status()
        return {"path": path, "status": "written"}

    async def files_mkdir(self, path: str) -> dict[str, str]:
        resp = await self._client.request(
            "MKCOL", f"/remote.php/dav/files/{self.username}/{path.strip('/')}"
        )
        resp.raise_for_status()
        return {"path": path, "status": "created"}

    async def files_delete(self, path: str) -> dict[str, str]:
        resp = await self._client.delete(f"/remote.php/dav/files/{self.username}/{path.strip('/')}")
        resp.raise_for_status()
        return {"path": path, "status": "deleted"}

    async def files_move(self, source: str, destination: str) -> dict[str, str]:
        resp = await self._client.request(
            "MOVE",
            f"/remote.php/dav/files/{self.username}/{source.strip('/')}",
            headers={"Destination": f"{self.url}/remote.php/dav/files/{self.username}/{destination.strip('/')}"},
        )
        resp.raise_for_status()
        return {"from": source, "to": destination}

    async def files_copy(self, source: str, destination: str) -> dict[str, str]:
        resp = await self._client.request(
            "COPY",
            f"/remote.php/dav/files/{self.username}/{source.strip('/')}",
            headers={"Destination": f"{self.url}/remote.php/dav/files/{self.username}/{destination.strip('/')}"},
        )
        resp.raise_for_status()
        return {"from": source, "to": destination}

    async def files_search(self, query: str, path: str | None = None) -> list[dict[str, Any]]:
        scope = f"/files/{self.username}/{(path or '').strip('/')}"
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            "<d:basicsearch><d:select><d:prop>"
            "<d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><oc:fileid/>"
            f"</d:prop></d:select><d:from><d:scope><d:href>{escape_xml(scope)}</d:href><d:depth>infinity</d:depth>"
            f"</d:scope></d:from><d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>%{escape_xml(query)}%</d:literal>"
            "</d:like></d:where></d:basicsearch></d:searchrequest>"
        )
        xml = await self._dav_request("SEARCH", "/remote.php/dav/", body=body)
        return self._parse_webdav_propfind(xml)

    async def files_list_favorites(self) -> list[dict[str, Any]]:
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
            "<d:prop><d:getlastmodified/><d:getcontentlength/><oc:fileid/><oc:favorite/></d:prop>"
            "<oc:filter-rules><oc:favorite>1</oc:favorite></oc:filter-rules>"
            "</oc:filter-files>"
        )
        xml = await self._dav_request(
            "REPORT", f"/remote.php/dav/files/{self.username}/", body=body, headers={"Depth": "infinity"}
        )
        return self._parse_webdav_propfind(xml)

    # ══════════════════════════════════════════════════════════════════════
    # Trashbin
    # ══════════════════════════════════════════════════════════════════════

    async def trashbin_list(self) -> list[dict[str, Any]]:
        xml = await self._dav_request(
            "PROPFIND",
            f"/remote.php/dav/trashbin/{self.username}/trash/",
            body='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getlastmodified/><d:getcontentlength/><oc:trashbin-original-location/><oc:trashbin-deletion-time/></d:prop></d:propfind>',
            headers={"Depth": "1"},
        )
        return self._parse_webdav_propfind(xml)

    async def trashbin_restore(self, trash_path: str) -> dict[str, str]:
        resp = await self._client.request(
            "MOVE",
            f"/remote.php/dav/trashbin/{self.username}/trash/{trash_path}",
            headers={"Destination": f"{self.url}/remote.php/dav/trashbin/{self.username}/restore/{trash_path}"},
        )
        resp.raise_for_status()
        return {"status": "restored", "path": trash_path}

    async def trashbin_delete(self, trash_path: str) -> dict[str, str]:
        resp = await self._client.delete(f"/remote.php/dav/trashbin/{self.username}/trash/{trash_path}")
        resp.raise_for_status()
        return {"status": "deleted", "path": trash_path}

    async def trashbin_empty(self) -> dict[str, str]:
        resp = await self._client.delete(f"/remote.php/dav/trashbin/{self.username}/trash/")
        resp.raise_for_status()
        return {"status": "emptied"}

    # ══════════════════════════════════════════════════════════════════════
    # Deck (Kanban)
    # ══════════════════════════════════════════════════════════════════════

    async def deck_list_boards(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/apps/deck/api/v1.0/boards")

    async def deck_get_board(self, board_id: int) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}")

    async def deck_create_board(self, title: str, color: str | None = None) -> Any:
        body: dict[str, Any] = {"title": title}
        if color:
            body["color"] = color
        return await self._ocs_post("/ocs/v2.php/apps/deck/api/v1.0/boards", body)

    async def deck_delete_board(self, board_id: int) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}")

    async def deck_list_stacks(self, board_id: int) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks")

    async def deck_create_stack(self, board_id: int, title: str, order: int | None = None) -> Any:
        body: dict[str, Any] = {"title": title}
        if order is not None:
            body["order"] = order
        return await self._ocs_post(f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks", body)

    async def deck_create_card(
        self, board_id: int, stack_id: int, title: str, description: str | None = None, duedate: str | None = None
    ) -> Any:
        body: dict[str, Any] = {"title": title, "type": "plain"}
        if description:
            body["description"] = description
        if duedate:
            body["duedate"] = duedate
        return await self._ocs_post(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards", body
        )

    async def deck_update_card(
        self,
        board_id: int,
        stack_id: int,
        card_id: int,
        title: str | None = None,
        description: str | None = None,
        duedate: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"type": "plain"}
        if title:
            body["title"] = title
        if description:
            body["description"] = description
        if duedate:
            body["duedate"] = duedate
        return await self._ocs_put(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards/{card_id}", body
        )

    async def deck_delete_card(self, board_id: int, stack_id: int, card_id: int) -> Any:
        return await self._ocs_delete(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards/{card_id}"
        )

    async def deck_move_card(self, board_id: int, stack_id: int, card_id: int, target_stack_id: int) -> Any:
        return await self._ocs_put(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards/{card_id}/reorder",
            {"stackId": target_stack_id, "order": 0},
        )

    async def deck_assign_label(self, board_id: int, stack_id: int, card_id: int, label_id: int) -> Any:
        return await self._ocs_put(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards/{card_id}/assignLabel",
            {"labelId": label_id},
        )

    async def deck_assign_user(self, board_id: int, stack_id: int, card_id: int, user_id: str) -> Any:
        return await self._ocs_put(
            f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/stacks/{stack_id}/cards/{card_id}/assignUser",
            {"userId": user_id},
        )

    async def deck_create_label(self, board_id: int, title: str, color: str | None = None) -> Any:
        body: dict[str, Any] = {"title": title}
        if color:
            body["color"] = color
        return await self._ocs_post(f"/ocs/v2.php/apps/deck/api/v1.0/boards/{board_id}/labels", body)

    # ══════════════════════════════════════════════════════════════════════
    # Tables
    # ══════════════════════════════════════════════════════════════════════

    async def tables_list(self) -> Any:
        resp = await self._client.get("/index.php/apps/tables/api/1/tables", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def tables_get(self, table_id: int) -> Any:
        resp = await self._client.get(f"/index.php/apps/tables/api/1/tables/{table_id}", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def tables_get_columns(self, table_id: int) -> Any:
        resp = await self._client.get(f"/index.php/apps/tables/api/1/tables/{table_id}/columns", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def tables_get_rows(self, table_id: int, limit: int | None = None, offset: int | None = None) -> Any:
        params: dict[str, Any] = {}
        if limit:
            params["limit"] = limit
        if offset:
            params["offset"] = offset
        resp = await self._client.get(f"/index.php/apps/tables/api/1/tables/{table_id}/rows", params=params, headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def tables_create_row(self, table_id: int, data: dict[str, Any]) -> Any:
        resp = await self._client.post(
            f"/index.php/apps/tables/api/1/tables/{table_id}/rows",
            json={"data": data},
            headers={"OCS-APIRequest": "true"},
        )
        resp.raise_for_status()
        return resp.json()

    async def tables_update_row(self, row_id: int, data: dict[str, Any]) -> Any:
        resp = await self._client.put(
            f"/index.php/apps/tables/api/1/rows/{row_id}",
            json={"data": data},
            headers={"OCS-APIRequest": "true"},
        )
        resp.raise_for_status()
        return resp.json()

    async def tables_delete_row(self, row_id: int) -> Any:
        resp = await self._client.delete(f"/index.php/apps/tables/api/1/rows/{row_id}", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return {"status": "deleted", "rowId": row_id}

    # ══════════════════════════════════════════════════════════════════════
    # Sharing
    # ══════════════════════════════════════════════════════════════════════

    async def shares_list(self, path: str | None = None) -> Any:
        params: dict[str, Any] = {}
        if path:
            params["path"] = path
        return await self._ocs_get("/ocs/v2.php/apps/files_sharing/api/v1/shares", params)

    async def shares_get(self, share_id: int) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/files_sharing/api/v1/shares/{share_id}")

    async def shares_create(
        self,
        path: str,
        share_type: int,
        share_with: str | None = None,
        permissions: int | None = None,
        password: str | None = None,
        expire_date: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"path": path, "shareType": share_type}
        if share_with:
            body["shareWith"] = share_with
        if permissions is not None:
            body["permissions"] = permissions
        if password:
            body["password"] = password
        if expire_date:
            body["expireDate"] = expire_date
        return await self._ocs_post("/ocs/v2.php/apps/files_sharing/api/v1/shares", body)

    async def shares_update(
        self,
        share_id: int,
        permissions: int | None = None,
        password: str | None = None,
        expire_date: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {}
        if permissions is not None:
            body["permissions"] = permissions
        if password:
            body["password"] = password
        if expire_date:
            body["expireDate"] = expire_date
        return await self._ocs_put(f"/ocs/v2.php/apps/files_sharing/api/v1/shares/{share_id}", body)

    async def shares_delete(self, share_id: int) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/apps/files_sharing/api/v1/shares/{share_id}")

    # ══════════════════════════════════════════════════════════════════════
    # Talk
    # ══════════════════════════════════════════════════════════════════════

    async def talk_list_conversations(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/apps/spreed/api/v4/room")

    async def talk_get_conversation(self, token: str) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/spreed/api/v4/room/{token}")

    async def talk_create_conversation(self, room_type: int, room_name: str, invite: str | None = None) -> Any:
        body: dict[str, Any] = {"roomType": room_type, "roomName": room_name}
        if invite:
            body["invite"] = invite
        return await self._ocs_post("/ocs/v2.php/apps/spreed/api/v4/room", body)

    async def talk_get_messages(self, token: str, limit: int | None = None) -> Any:
        params: dict[str, Any] = {"lookIntoFuture": 0}
        if limit:
            params["limit"] = limit
        return await self._ocs_get(f"/ocs/v2.php/apps/spreed/api/v1/chat/{token}", params)

    async def talk_send_message(self, token: str, message: str, reply_to: int | None = None) -> Any:
        body: dict[str, Any] = {"message": message}
        if reply_to:
            body["replyTo"] = reply_to
        return await self._ocs_post(f"/ocs/v2.php/apps/spreed/api/v1/chat/{token}", body)

    async def talk_delete_message(self, token: str, message_id: int) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/apps/spreed/api/v1/chat/{token}/{message_id}")

    async def talk_get_participants(self, token: str) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/spreed/api/v4/room/{token}/participants")

    async def talk_create_poll(self, token: str, question: str, options: list[str], max_votes: int | None = None) -> Any:
        body: dict[str, Any] = {"question": question, "options": options, "resultMode": 0}
        if max_votes is not None:
            body["maxVotes"] = max_votes
        return await self._ocs_post(f"/ocs/v2.php/apps/spreed/api/v1/poll/{token}", body)

    async def talk_vote_poll(self, token: str, poll_id: int, option_ids: list[int]) -> Any:
        return await self._ocs_post(
            f"/ocs/v2.php/apps/spreed/api/v1/poll/{token}/{poll_id}", {"optionIds": option_ids}
        )

    async def talk_close_poll(self, token: str, poll_id: int) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/apps/spreed/api/v1/poll/{token}/{poll_id}")

    # ══════════════════════════════════════════════════════════════════════
    # Notifications
    # ══════════════════════════════════════════════════════════════════════

    async def notifications_list(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/apps/notifications/api/v2/notifications")

    async def notifications_dismiss(self, notification_id: int) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/apps/notifications/api/v2/notifications/{notification_id}")

    async def notifications_dismiss_all(self) -> Any:
        return await self._ocs_delete("/ocs/v2.php/apps/notifications/api/v2/notifications")

    # ══════════════════════════════════════════════════════════════════════
    # Activity
    # ══════════════════════════════════════════════════════════════════════

    async def activity_get(self, limit: int | None = None, since_id: int | None = None) -> Any:
        params: dict[str, Any] = {}
        if limit:
            params["limit"] = limit
        if since_id:
            params["since"] = since_id
        return await self._ocs_get("/ocs/v2.php/apps/activity/api/v2/activity", params)

    # ══════════════════════════════════════════════════════════════════════
    # Users
    # ══════════════════════════════════════════════════════════════════════

    async def users_get_current(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/cloud/user")

    async def users_list(self, search: str | None = None, limit: int | None = None) -> Any:
        params: dict[str, Any] = {}
        if search:
            params["search"] = search
        if limit:
            params["limit"] = limit
        return await self._ocs_get("/ocs/v2.php/cloud/users", params)

    async def users_get(self, user_id: str) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/cloud/users/{user_id}")

    # ══════════════════════════════════════════════════════════════════════
    # User Status
    # ══════════════════════════════════════════════════════════════════════

    async def user_status_get(self, user_id: str | None = None) -> Any:
        if user_id:
            return await self._ocs_get(f"/ocs/v2.php/apps/user_status/api/v1/statuses/{user_id}")
        return await self._ocs_get("/ocs/v2.php/apps/user_status/api/v1/user_status")

    async def user_status_set(self, status_type: str, message: str | None = None, icon: str | None = None) -> Any:
        # Set online/away/dnd/invisible/offline status
        result = await self._ocs_put("/ocs/v2.php/apps/user_status/api/v1/user_status/status", {"statusType": status_type})
        # Optionally set a custom message
        if message or icon:
            msg_body: dict[str, Any] = {}
            if message:
                msg_body["message"] = message
            if icon:
                msg_body["statusIcon"] = icon
            result = await self._ocs_put("/ocs/v2.php/apps/user_status/api/v1/user_status/message/custom", msg_body)
        return result

    async def user_status_clear(self) -> Any:
        return await self._ocs_delete("/ocs/v2.php/apps/user_status/api/v1/user_status/message")

    # ══════════════════════════════════════════════════════════════════════
    # Search
    # ══════════════════════════════════════════════════════════════════════

    async def search_providers(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/search/providers")

    async def unified_search(self, provider_id: str, query: str, limit: int | None = None) -> Any:
        params: dict[str, Any] = {"term": query}
        if limit:
            params["limit"] = limit
        return await self._ocs_get(f"/ocs/v2.php/search/providers/{provider_id}/search", params)

    # ══════════════════════════════════════════════════════════════════════
    # Mail (Nextcloud Mail app)
    # ══════════════════════════════════════════════════════════════════════

    async def mail_list_accounts(self) -> Any:
        resp = await self._client.get("/index.php/apps/mail/api/accounts", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def mail_list_mailboxes(self, account_id: int) -> Any:
        resp = await self._client.get(
            "/index.php/apps/mail/api/mailboxes", params={"accountId": account_id}, headers={"OCS-APIRequest": "true"}
        )
        resp.raise_for_status()
        return resp.json()

    async def mail_list_messages(self, account_id: int, folder_id: int, limit: int | None = None) -> Any:
        params: dict[str, Any] = {"accountId": account_id, "folderId": folder_id}
        if limit:
            params["limit"] = limit
        resp = await self._client.get(
            "/index.php/apps/mail/api/messages",
            params=params,
            headers={"OCS-APIRequest": "true", "requesttoken": "nocheck"},
        )
        resp.raise_for_status()
        return resp.json()

    async def mail_get_message(self, message_id: int) -> Any:
        resp = await self._client.get(f"/index.php/apps/mail/api/messages/{message_id}", headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        return resp.json()

    async def mail_send(
        self, account_id: int, to: str, subject: str, body: str, cc: str | None = None, bcc: str | None = None
    ) -> Any:
        # Nextcloud Mail uses the outbox pattern: POST to outbox, then send
        data: dict[str, Any] = {
            "accountId": account_id,
            "subject": subject,
            "body": body,
            "to": to,
            "type": 0,  # 0 = new message
        }
        if cc:
            data["cc"] = cc
        if bcc:
            data["bcc"] = bcc
        # Create outbox message
        resp = await self._client.post("/index.php/apps/mail/api/outbox", json=data, headers={"OCS-APIRequest": "true"})
        resp.raise_for_status()
        result = resp.json()
        # Send it immediately
        msg_id = result.get("id")
        if msg_id:
            send_resp = await self._client.post(f"/index.php/apps/mail/api/outbox/{msg_id}", headers={"OCS-APIRequest": "true"})
            send_resp.raise_for_status()
            return send_resp.json() if send_resp.content else {"status": "sent", "id": msg_id}
        return result

    # ══════════════════════════════════════════════════════════════════════
    # Tags
    # ══════════════════════════════════════════════════════════════════════

    async def tags_list(self) -> Any:
        xml = await self._dav_request(
            "PROPFIND",
            "/remote.php/dav/systemtags/",
            body='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:display-name/><oc:user-visible/><oc:user-assignable/><oc:id/></d:prop></d:propfind>',
            headers={"Depth": "1"},
        )
        ids = self._extract_xml_values(xml, "id")
        names = self._extract_xml_values(xml, "display-name")
        return [{"id": ids[i], "name": names[i]} for i in range(min(len(ids), len(names)))]

    async def tags_create(self, name: str, user_visible: bool = True, user_assignable: bool = True) -> Any:
        resp = await self._client.post(
            "/remote.php/dav/systemtags/",
            json={"name": name, "userVisible": user_visible, "userAssignable": user_assignable},
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        return {"name": name, "status": "created"}

    async def tags_assign(self, file_id: int, tag_id: int) -> Any:
        resp = await self._client.put(f"/remote.php/dav/systemtags-relations/files/{file_id}/{tag_id}")
        resp.raise_for_status()
        return {"fileId": file_id, "tagId": tag_id, "status": "assigned"}

    async def tags_unassign(self, file_id: int, tag_id: int) -> Any:
        resp = await self._client.delete(f"/remote.php/dav/systemtags-relations/files/{file_id}/{tag_id}")
        resp.raise_for_status()
        return {"fileId": file_id, "tagId": tag_id, "status": "unassigned"}

    # ══════════════════════════════════════════════════════════════════════
    # Versions
    # ══════════════════════════════════════════════════════════════════════

    async def versions_list(self, file_id: int) -> Any:
        xml = await self._dav_request(
            "PROPFIND",
            f"/remote.php/dav/versions/{self.username}/versions/{file_id}",
            body='<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
            headers={"Depth": "1"},
        )
        return self._parse_webdav_propfind(xml)

    async def versions_restore(self, file_id: int, version_id: str) -> Any:
        resp = await self._client.request(
            "COPY",
            f"/remote.php/dav/versions/{self.username}/versions/{file_id}/{version_id}",
            headers={"Destination": f"{self.url}/remote.php/dav/versions/{self.username}/restore/target"},
        )
        resp.raise_for_status()
        return {"status": "restored", "fileId": file_id, "versionId": version_id}

    # ══════════════════════════════════════════════════════════════════════
    # Comments
    # ══════════════════════════════════════════════════════════════════════

    async def comments_list(self, file_id: int) -> Any:
        xml = await self._dav_request(
            "REPORT",
            f"/remote.php/dav/comments/files/{file_id}",
            body='<?xml version="1.0" encoding="UTF-8"?><oc:filter-comments xmlns:oc="http://owncloud.org/ns" xmlns:D="DAV:"><oc:limit>200</oc:limit></oc:filter-comments>',
        )
        messages = self._extract_xml_values(xml, "message")
        actors = self._extract_xml_values(xml, "actorDisplayName")
        dates = self._extract_xml_values(xml, "creationDateTime")
        return [
            {"message": messages[i], "author": actors[i] if i < len(actors) else "", "date": dates[i] if i < len(dates) else ""}
            for i in range(len(messages))
        ]

    async def comments_add(self, file_id: int, message: str) -> Any:
        resp = await self._client.post(
            f"/remote.php/dav/comments/files/{file_id}",
            json={"actorType": "users", "message": message, "verb": "comment"},
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        return {"status": "created", "fileId": file_id}

    # ══════════════════════════════════════════════════════════════════════
    # Apps
    # ══════════════════════════════════════════════════════════════════════

    async def apps_list(self, filter_val: str | None = None) -> Any:
        params: dict[str, Any] = {}
        if filter_val:
            params["filter"] = filter_val
        return await self._ocs_get("/ocs/v2.php/cloud/apps", params)

    async def apps_get_info(self, app_id: str) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/cloud/apps/{app_id}")

    async def apps_enable(self, app_id: str) -> Any:
        return await self._ocs_post(f"/ocs/v2.php/cloud/apps/{app_id}")

    async def apps_disable(self, app_id: str) -> Any:
        return await self._ocs_delete(f"/ocs/v2.php/cloud/apps/{app_id}")

    # ══════════════════════════════════════════════════════════════════════
    # Forms
    # ══════════════════════════════════════════════════════════════════════

    async def forms_list(self) -> Any:
        return await self._ocs_get("/ocs/v2.php/apps/forms/api/v3/forms")

    async def forms_get(self, form_id: int) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/forms/api/v3/forms/{form_id}")

    async def forms_get_submissions(self, form_id: int) -> Any:
        return await self._ocs_get(f"/ocs/v2.php/apps/forms/api/v3/forms/{form_id}/submissions")

    # ══════════════════════════════════════════════════════════════════════
    # Internal parsing helpers
    # ══════════════════════════════════════════════════════════════════════

    def _parse_calendar_data(self, xml: str, component_type: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        cal_blocks = self._extract_xml_values(xml, "calendar-data")
        for block in cal_blocks:
            entry: dict[str, Any] = {}
            lines = block.split("\n")
            in_component = False
            for line in lines:
                line = line.strip("\r")
                if line.startswith(f"BEGIN:{component_type}"):
                    in_component = True
                    continue
                if line.startswith(f"END:{component_type}"):
                    in_component = False
                    continue
                if not in_component:
                    continue
                colon_idx = line.find(":")
                if colon_idx == -1:
                    continue
                key = line[:colon_idx].split(";")[0].lower()
                val = line[colon_idx + 1 :]
                if key in (
                    "uid", "summary", "description", "location", "dtstart", "dtend",
                    "due", "status", "priority", "percent-complete", "categories", "created",
                ):
                    if key == "percent-complete":
                        key = "percentComplete"
                    entry[key] = val
            if entry:
                results.append(entry)
        return results

    def _parse_vcards(self, xml: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        vcard_blocks = self._extract_xml_values(xml, "address-data")
        for block in vcard_blocks:
            contact: dict[str, Any] = {}
            for line in block.split("\n"):
                line = line.strip("\r\n").replace("&#13;", "")
                if line.startswith("FN:"):
                    contact["fullName"] = line[3:].strip()
                elif line.startswith("UID:"):
                    contact["uid"] = line[4:].strip()
                elif "EMAIL" in line:
                    v = line.split(":")[-1].strip()
                    if v:
                        contact["email"] = v
                elif "TEL" in line:
                    v = line.split(":")[-1].strip()
                    if v:
                        contact["phone"] = v
                elif line.startswith("ORG:"):
                    contact["org"] = line[4:].strip()
                elif line.startswith("TITLE:"):
                    contact["title"] = line[6:].strip()
                elif line.startswith("NOTE:"):
                    contact["note"] = line[5:].strip()
            if contact.get("fullName") or contact.get("uid"):
                results.append(contact)
        return results

    def _parse_webdav_propfind(self, xml: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        responses = re.split(r"<(?:D:|d:)?response>", xml, flags=re.IGNORECASE)[1:]
        for resp in responses:
            entry: dict[str, Any] = {}
            hrefs = self._extract_hrefs("<r>" + resp)
            entry["href"] = hrefs[0] if hrefs else ""
            parts = entry["href"].split("/")
            entry["name"] = next((p for p in reversed(parts) if p), "")

            lastmod = self._extract_xml_values(resp, "getlastmodified")
            if lastmod:
                entry["lastModified"] = lastmod[0]

            size = self._extract_xml_values(resp, "getcontentlength")
            if size:
                entry["size"] = int(size[0])

            ct = self._extract_xml_values(resp, "getcontenttype")
            if ct:
                entry["contentType"] = ct[0]

            fid = self._extract_xml_values(resp, "fileid")
            if fid:
                entry["fileId"] = int(fid[0])

            oc_size = self._extract_xml_values(resp, "size")
            if oc_size and "size" not in entry:
                entry["size"] = int(oc_size[0])

            entry["isDirectory"] = any(
                k in resp for k in ["<d:collection", "<D:collection", ":collection"]
            )

            fav = self._extract_xml_values(resp, "favorite")
            if fav:
                entry["favorite"] = fav[0] == "1"

            results.append(entry)
        return results
