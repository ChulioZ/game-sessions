/* Spielwirbel – inbox view (issue #207). The generic per-user notification
   inbox: it lists actionable items that later account features deliver — round
   invitations (#207) and friend requests (#325) — and lets the user mark one
   read or dismiss it. Those producers arrive in later slices, so this foundation
   ships the surface with nothing writing to it yet; items are generic here and
   each producing feature will render its own type (with accept/decline actions).

   Account-mode only: a logged-out visitor (or legacy mode) is sent home rather
   than shown an empty shell. Part of the shared frontend scope — loads after
   account.js/core.js and uses their helpers (accountApi/isLoggedIn/setInboxDot,
   h/esc/app/t/toast, syncUrl/setContext). */

'use strict';

async function showInbox() {
  // The inbox is a per-account surface; without an account there is nothing to
  // show, so fall back Home instead of rendering an empty screen.
  if (!(accountsActive() && isLoggedIn())) return showHome();
  currentView = () => showInbox();
  syncUrl('/inbox');
  setContext(t('inbox.title'));
  applyBackground(null);
  app.innerHTML = '<p class="muted">…</p>';

  let res;
  try {
    res = await accountApi('GET', '/inbox');
  } catch { return; } // accountApi already handled a dead session (→ login)
  const items = res.items;

  setInboxDot(items.some((i) => !i.read));

  app.innerHTML = '';
  app.appendChild(h(`<div class="lobby-head"><h1>${esc(t('inbox.title'))}</h1></div>`));

  if (!items.length) {
    app.appendChild(h(`<p class="muted empty-note">${esc(t('inbox.empty'))}</p>`));
    return;
  }

  const list = h('<div class="ds-list"></div>');
  for (const item of items) list.appendChild(renderInboxItem(item));
  app.appendChild(list);
}

// One inbox row. Items are generic in this slice (no type-specific accept/decline
// actions yet): a title, its timestamp, a read/unread mark, and a dismiss button.
// Clicking an unread row marks it read. The unread state is signalled by both a
// dot (an element with an aria-label) and a bolder title, never colour alone.
function renderInboxItem(item) {
  const dot = item.read
    ? ''
    : `<span class="inbox-row__dot" role="img" aria-label="${esc(t('inbox.unread'))}"></span>`;
  const row = h(`<div class="ds-row inbox-row${item.read ? '' : ' inbox-row--unread'}">
      <div class="ds-row__main">
        <div class="ds-row__date">${dot}${esc(t('inbox.item'))}</div>
        <div class="ds-row__status muted">${esc(fmtDateTime(item.createdAt))}</div>
      </div>
      <div class="ds-row__meta">
        <button class="link-btn inbox-row__del" type="button" aria-label="${esc(t('inbox.dismiss'))}"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>
    </div>`);

  if (!item.read) {
    row.addEventListener('click', async (ev) => {
      if (ev.target.closest('.inbox-row__del')) return; // the dismiss button has its own handler
      try {
        await accountApi('POST', `/inbox/${item.id}/read`);
        item.read = true;
        row.classList.remove('inbox-row--unread');
        const d = row.querySelector('.inbox-row__dot');
        if (d) d.remove();
        refreshInboxBadge();
      } catch {}
    });
  }

  row.querySelector('.inbox-row__del').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      await accountApi('DELETE', `/inbox/${item.id}`);
      row.remove();
      refreshInboxBadge();
      if (!app.querySelector('.inbox-row')) showInbox(); // nothing left → re-render the empty state
    } catch {}
  });

  return row;
}
