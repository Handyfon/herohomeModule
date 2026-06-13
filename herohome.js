Hooks.once('init', function() {
    game.settings.register('herohome', 'token', {
        name: 'herohome token',
        hint: 'This is the token for your account, dont share it!',
        scope: 'client',
        config: true,
        default: '',
        type: String,
    });

    console.log('Initialized HeroHome-Module');
});

Hooks.once('ready', function() {
Hooks.on('renderActorSheetV2', async (app, html, data) => {
    const button = $('<a class="herohome-button" title="HeroHome Import/export"><i class="fa-solid fa-vault navIcon" style="place-self: center;"></i>HeroHome</a>');
    
    button.on('click', async (event) => {
        let token = await game.settings.get('herohome', 'token');
        if (!token) {
            const dialogContent = `
                <div class="herohome-dialog-content">
                    <p>Please set your HeroHome token to access the import/export feature.</p>
                    <p>Visit the HeroHome website to generate a token:</p>
                    <a href="https://herohome.me/secret_key/" target="_blank">Generate Token</a>
                    <div class="herohome-token-input">
                        <label for="herohome-token">Enter Token:</label>
                        <input type="text" id="herohome-token" name="herohome-token">
                    </div>
                </div>
            `;
            
            const dialogOptions = {
                title: 'Set HeroHome Token',
                content: dialogContent,
                buttons: {
                    ok: {
                        icon: '<i class="fas fa-check"></i>',
                        label: 'OK',
                        callback: async (html) => {
                            const enteredToken = html.find('#herohome-token').val();
                            if (enteredToken) {
                                token = enteredToken;
                                await game.settings.set('herohome', 'token', token);
                                await loadCharacterList(app.actor);
                            }
                        }
                    }
                },
                default: 'ok'
            };

            new Dialog(dialogOptions).render(true);
        } else {
            await loadCharacterList(app.actor);
        }
    });

    const $html = $(html);
    const header = $html.closest('.application').find('.window-header');
    if (header.length) {
        // Re-renders fire this hook again — replace any existing button instead
        // of stacking duplicates (and their stale click handlers) in the header.
        header.find('.herohome-button').remove();

        const closeButton = header.find('button[data-action="close"]');
        if (closeButton.length) {
            button.addClass("header-control");
            closeButton.before(button); // ← direkt davor einfügen
        } else {
            header.append(button); // fallback
        }
    }
    checkForNewVersion(app.actor);
});


    HeroHome.startTimer();
    if (game.user.isGM) {
        // Select the journal sidebar container
        let journalSidebar = $(".journal-sidebar");
        
        // Create the new button element
        let newButton = $("<button>").addClass("heroHomeSyncJournal")
        .html('<i class="fas fa-icon-of-your-choice"></i> <b>Hero Home Sync</b>')
        .on('click', syncJournalToFallback);
        // Append the new button just after the header inside the journalSidebar
        journalSidebar.find(".directory-header").after(newButton);
    }
});

// --------------------------------------------------------------------------
// Character list cache
// Shared by the HeroHome dialog and the import picker. Three layers:
//   1. TTL — within 60s the list is served from memory, zero requests.
//   2. Event-driven invalidation — our own uploads/overwrites/syncs flush it.
//   3. ETag revalidation — an expired cache revalidates with If-None-Match;
//      if nothing changed the server answers with a bodyless 304.
// --------------------------------------------------------------------------
const HHCache = {
    TTL: 60 * 1000,
    _list: { data: null, etag: null, fetchedAt: 0 },

    invalidate() {
        this._list.fetchedAt = 0;
    },

    async getCharacterList({ force = false } = {}) {
        const now = Date.now();
        if (!force && this._list.data && (now - this._list.fetchedAt) < this.TTL) {
            return this._list.data;
        }

        const token = game.settings.get('herohome', 'token');
        const headers = { 'Secret-Key': token };
        if (this._list.data && this._list.etag) headers['If-None-Match'] = this._list.etag;

        const response = await fetch('https://herohome.me/api/characters/', { headers });

        if (response.status === 304) {
            this._list.fetchedAt = now;
            return this._list.data;
        }
        if (!response.ok) {
            throw new Error('HeroHome | character list request failed: ' + response.status);
        }

        this._list.data = await response.json();
        this._list.etag = response.headers.get('ETag');
        this._list.fetchedAt = now;
        return this._list.data;
    }
};

// Version checks hit a tiny metadata endpoint instead of downloading the whole
// character, and each character is checked at most once per TTL — opening and
// closing a sheet repeatedly no longer spams the server.
const HH_VERSION_CHECK_TTL = 5 * 60 * 1000;
const _hhVersionChecks = new Map();

async function checkForNewVersion(currentCharacter) {
    const hh = currentCharacter?.flags?.herohome;
    if (!hh?.characterid || !hh?.lastsync) return;

    const lastCheck = _hhVersionChecks.get(hh.characterid);
    if (lastCheck && Date.now() - lastCheck < HH_VERSION_CHECK_TTL) return;
    _hhVersionChecks.set(hh.characterid, Date.now());

    const token = game.settings.get('herohome', 'token');
    if (!token) return;

    try {
        const response = await fetch(`https://herohome.me/api/character_meta/${hh.characterid}/`, {
            headers: {
                'Secret-Key': token,
            },
        });

        if (!response.ok) {
            console.error('HeroHome | version check failed:', response.status);
            return;
        }

        const meta = await response.json();
        if (new Date(meta.lastsync) > new Date(hh.lastsync)) {
            const updateDialogOptions = {
                title: 'Herohome Sync',
                content: '<div class="herohome-dialog-content"><p>A newer version of this character is available on HeroHome. Do you want to update?</p></div>',
                buttons: {
                    yes: {
                        icon: '<i class="fas fa-download"></i>',
                        label: 'Update',
                        // The full character is only downloaded if the user actually wants it
                        callback: async () => fetchAndApplyCharacter(hh.characterid, currentCharacter)
                    },
                    no: {
                        icon: '<i class="fas fa-times"></i>',
                        label: 'Cancel',
                        callback: () => {}
                    }
                },
                default: 'no'
            };

            new Dialog(updateDialogOptions).render(true);
        }
    } catch (error) {
        console.error('HeroHome | version check error:', error);
    }
}

// Characters stored on HeroHome may have been uploaded with an older system
// version. Run them through Foundry's built-in data migration so imports land
// on the current schema. Actor.migrateData cascades over embedded items —
// migrating items a second time individually can corrupt already-migrated data.
function migrateToCurrentSystemVersion(data) {
    try {
        const migrated = Actor.implementation.migrateData(foundry.utils.deepClone(data));
        return sanitizeLegacyReferences(migrated);
    } catch (e) {
        console.warn('HeroHome | system migration failed, importing raw data', e);
        return sanitizeLegacyReferences(data);
    }
}

// Very old characters carry source references that are no valid UUIDs anymore.
// dnd5e 5.x crashes during Item5e.prepareData on those (SourcedItemsMap.set →
// parseUuid returns null), which cascades into broken advancement/activities.
// Strip any reference that the current parseUuid cannot understand.
function sanitizeLegacyReferences(data) {
    const isValidUuid = (value) => {
        if (!value || typeof value !== 'string') return false;
        try {
            return !!foundry.utils.parseUuid(value);
        } catch (e) {
            return false;
        }
    };
    for (const item of data?.items ?? []) {
        const coreSource = item?.flags?.core?.sourceId;
        if (coreSource && !isValidUuid(coreSource)) {
            console.log('HeroHome | dropping invalid sourceId on', item.name, '→', coreSource);
            delete item.flags.core.sourceId;
        }
        const dnd5eSource = item?.flags?.dnd5e?.sourceId;
        if (dnd5eSource && !isValidUuid(dnd5eSource)) {
            console.log('HeroHome | dropping invalid dnd5e sourceId on', item.name, '→', dnd5eSource);
            delete item.flags.dnd5e.sourceId;
        }
        const compendiumSource = item?._stats?.compendiumSource;
        if (compendiumSource && !isValidUuid(compendiumSource)) {
            console.log('HeroHome | dropping invalid compendiumSource on', item.name, '→', compendiumSource);
            item._stats.compendiumSource = null;
        }
    }
    return data;
}

// Some system changes (e.g. dnd5e's activities rework) are only handled by the
// system's own world migration, which never runs for freshly imported documents.
// Apply it explicitly to a single actor after import/update.
async function applySystemMigration(actor) {
    try {
        if (!actor || game.system.id !== 'dnd5e') return;
        const migrations = globalThis.dnd5e?.migrations;
        if (!migrations?.migrateActorData) return;
        const migrationData = migrations.getMigrationData ? await migrations.getMigrationData() : {};
        const updateData = migrations.migrateActorData(actor.toObject(), migrationData);
        if (updateData && !foundry.utils.isEmpty(updateData)) {
            console.log('HeroHome | applying dnd5e system migration to', actor.name);
            await actor.update(updateData, { enforceTypes: false, render: false });
        }
    } catch (e) {
        console.warn('HeroHome | system migration step failed for', actor?.name, e);
    }
}

// Shared download-and-apply used by both the update prompt and the list dialog
async function fetchAndApplyCharacter(characterId, actor, { reloadList = false } = {}) {
    try {
        const token = game.settings.get('herohome', 'token');
        const response = await fetch(`https://herohome.me/api/download_character/${characterId}/`, {
            headers: {
                'Content-Type': 'application/json',
                'Secret-Key': token
            }
        });

        if (!response.ok) {
            console.error('HeroHome | download failed:', response.status);
            return;
        }

        let characterData = await response.json();
        if (!actor) {
            console.error('HeroHome | Error: Actor not found');
            return;
        }

        // Authoritative sync marker from the server, with the legacy flag as fallback
        const serverSync = response.headers.get('X-Herohome-Created-At')
            || characterData?.flags?.herohome?.lastsync
            || null;

        // Gracefully lift characters from older system versions to the current one
        characterData = migrateToCurrentSystemVersion(characterData);

        // Remove old items from the actor
        const itemIDs = actor.items.map(i => i.id);
        await actor.deleteEmbeddedDocuments("Item", itemIDs);

        // Remove old effects from the actor
        const effectIDs = actor.effects.map(e => e.id);
        await actor.deleteEmbeddedDocuments("ActiveEffect", effectIDs);

        // Update the actor with the new data
        await actor.update(characterData);
        await actor.update({
            'flags.herohome.characterid': characterId,
            'flags.herohome.lastsync': serverSync,
        });

        // Lift the document onto the current system version (e.g. dnd5e activities)
        await applySystemMigration(actor);

        actor.sheet?.render(true);
        ui.notifications.notify('Character ' + actor.name + ' has been updated');
        if (reloadList) await loadCharacterList(actor);
    } catch (error) {
        console.error('HeroHome | download error:', error);
    }
}

async function loadCharacterList(currentCharacter) {
    let token = await game.settings.get('herohome', 'token');
    const dialogOptions = {
        title: 'HeroHome',
        content: '<h1 class="heroHomeSectionHeader">Current Character for "' + game.system.title + '"'
            + '<span class="herohome-version-pill" title="Current game system version">v' + game.system.version + '</span></h1>'
            + '<div class="herohome-dialog-content herohome-sheet-content">Loading...</div>',
        buttons: {},
    };
    // Always build a fresh dialog: re-rendering a cached instance races with the
    // (instant) cached list — content written into the old element gets wiped
    // by the re-render. Closing the old one also avoids stale actor bindings.
    if (HeroHome._screen) {
        try { HeroHome._screen.close(); } catch (e) { /* already closed */ }
    }
    // Full size from the first frame — the window must not spawn tiny while
    // the content is still loading.
    const dialog = new Dialog(dialogOptions, { width: 720, height: 800, resizable: true });
    HeroHome._screen = dialog;
    await dialog._render(true);

    try {
        const characters = await HHCache.getCharacterList();
        displayCharacterList(characters, currentCharacter, token);
    } catch (error) {
        console.error('Error:', error);
    }
}
// --------------------------------------------------------------------------
// "Hero Home Character" entry in the Create Actor dialog
// --------------------------------------------------------------------------
function injectHeroHomeCreateOption(app, root) {
    const el = root instanceof HTMLElement ? root : root?.[0];
    if (!el || el.querySelector('.herohome-create-option')) return;

    // Only document-creation dialogs that offer Actor types
    const typeInputs = Array.from(el.querySelectorAll('input[name="type"], select[name="type"] option'));
    if (!typeInputs.length) return;
    const actorTypes = game.documentTypes?.Actor || [];
    const offered = typeInputs.map(i => i.value).filter(Boolean);
    if (!offered.length || !offered.some(v => actorTypes.includes(v))) return;

    const openPicker = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await app.close();
        openHeroHomeImportPicker();
    };

    // dnd5e-style type list (ol.card with one li per type): add a native-looking entry
    const typeList = el.querySelector('ol.card, ol.unlist');
    if (typeList && typeList.querySelector('input[name="type"]')) {
        const li = document.createElement('li');
        li.className = 'herohome-create-option';
        li.innerHTML = '<label><i class="fa-solid fa-vault herohome-create-icon"></i>'
            + '<span>Hero Home Character</span>'
            + '<i class="fa-solid fa-file-import herohome-create-import-icon"></i></label>';
        li.addEventListener('click', openPicker);
        typeList.appendChild(li);
        return;
    }

    // Generic fallback: gold button above the dialog footer
    const form = el.querySelector('form') || el;
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'herohome-create-option';
    option.innerHTML = '<i class="fa-solid fa-vault"></i><span class="herohome-create-option-label">Hero Home Character'
        + '<small>Import a hero from your vault</small></span>';
    option.addEventListener('click', openPicker);

    const footer = form.querySelector('footer, .form-footer, .dialog-buttons');
    if (footer) footer.before(option);
    else form.appendChild(option);
}

Hooks.on('renderDialog', injectHeroHomeCreateOption);
Hooks.on('renderDialogV2', injectHeroHomeCreateOption);
// Systems like dnd5e replace the core dialog with their own ApplicationV2
// subclass (e.g. "dnd5e2 create-document") — the generic ApplicationV2 render
// hook fires for every subclass, and the guards above keep it cheap.
Hooks.on('renderApplicationV2', injectHeroHomeCreateOption);

// --------------------------------------------------------------------------
// Hero Home button in the Actors sidebar (below Create Actor / Create Folder)
// --------------------------------------------------------------------------
Hooks.on('renderActorDirectory', (app, html) => {
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el || el.querySelector('.herohome-sidebar-button')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'herohome-sidebar-button';
    button.innerHTML = '<i class="fa-solid fa-vault"></i> Hero Home';
    button.addEventListener('click', () => openHeroHomeCampaignOverview());

    const header = el.querySelector('.directory-header .header-actions')
        || el.querySelector('.directory-header .action-buttons')
        || el.querySelector('.directory-header');
    if (header) header.appendChild(button);
});

async function openHeroHomeCampaignOverview() {
    const token = game.settings.get('herohome', 'token');
    if (!token) {
        ui.notifications.warn('HeroHome | Please set your HeroHome token first (open any character sheet and click the HeroHome button).');
        return;
    }

    // Only one campaign dialog at a time — a second instance would duplicate
    // the content element and the render helper would write into both.
    if (HeroHome._campaignScreen) {
        try { HeroHome._campaignScreen.close(); } catch (e) { /* already closed */ }
    }

    const dialog = new Dialog({
        title: 'Hero Home — Campaign Vault',
        content: '<div class="herohome-dialog-content herohome-campaign-content">Loading your vault…</div>',
        buttons: {},
    }, { width: 900, height: 720, resizable: true });
    HeroHome._campaignScreen = dialog;
    // Await the render: while the previous instance is still in its closing
    // animation, polling would find the dying element and fill that instead.
    await dialog._render(true);
    renderHeroHomeCampaignContent();
}

// Dialog.render(true) is async — content written immediately afterwards races
// against the DOM. Wait until the target element actually exists (the cache
// resolves instantly, so this race is lost reliably without it).
async function hhWaitFor(selector, tries = 20) {
    for (let i = 0; i < tries; i++) {
        // .last(): while an old dialog instance is still in its closing
        // animation, both elements exist — the newest one is the live target.
        const el = $(selector).last();
        if (el.length) return el;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return $();
}

// View state of the campaign vault dialog — mirrors the website's character
// vault: list/grid toggle and stacking of same-named versions, both persisted.
const HHViewState = {
    get view() { return localStorage.getItem('hhVaultView') || 'grid'; },
    set view(v) { localStorage.setItem('hhVaultView', v); },
    get stack() { return localStorage.getItem('hhVaultStack') === '1'; },
    set stack(v) { localStorage.setItem('hhVaultStack', v ? '1' : '0'); },
    expanded: new Set(),
};

function renderVaultEntry(character, worldActors, { badge = '', child = false } = {}) {
    const actor = worldActors.get(character.id);
    const action = actor
        ? `<button class="herohome-open-actor" title="Open the sheet of ${actor.name}" data-actor-id="${actor.id}"><i class="fa-solid fa-eye"></i></button>`
        : `<button class="herohome-import" title="Import as new actor" data-character-id="${character.id}"><i class="fa-solid fa-file-import"></i></button>`;
    const campaignPill = actor ? '<span class="herohome-pill herohome-pill-campaign">In campaign</span>' : '';
    return `
        <li class="herohome-character${child ? ' hh-child' : ''}">
            <img src="${character.image_url}" alt="${character.name}" onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
            <div class="herohome-character-info">
                <span class="herohome-character-name">${character.name}</span>
                ${campaignPill}
                ${systemVersionPill(character)}
                ${badge}
                <span class="herohome-character-created-at">${formatDate(character.created_at)}</span>
            </div>
            <div class="herohome-character-actions">${action}</div>
        </li>
    `;
}

// Builds one list/grid, optionally stacking same-named versions (newest on
// top, older ones expandable) — same behaviour as the website vault.
function buildVaultListHtml(chars, worldActors) {
    const grid = HHViewState.view === 'grid';
    let items = [];
    if (HHViewState.stack) {
        const groups = new Map();
        for (const c of chars) {
            const key = (c.name || '').trim().toLowerCase();
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c); // chars arrive sorted newest-first
        }
        for (const [key, group] of groups) {
            const expanded = HHViewState.expanded.has(key);
            const older = group.length - 1;
            const badge = older > 0
                ? `<span class="herohome-stack-badge${expanded ? ' expanded' : ''}" data-group="${encodeURIComponent(key)}" title="Show older versions">`
                    + `<i class="fa-solid fa-layer-group"></i> ${older} older <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}"></i></span>`
                : '';
            items.push(renderVaultEntry(group[0], worldActors, { badge }));
            if (expanded) group.slice(1).forEach(c => items.push(renderVaultEntry(c, worldActors, { child: true })));
        }
    } else {
        items = chars.map(c => renderVaultEntry(c, worldActors, {}));
    }
    return '<ul class="herohome-character-list herohome-import-list' + (grid ? ' herohome-grid' : '') + '">'
        + items.join('') + '</ul>';
}

async function renderHeroHomeCampaignContent() {
    const content = await hhWaitFor('.herohome-campaign-content');
    if (!content.length) {
        console.error('HeroHome | campaign dialog content element never appeared');
        return;
    }

    try {
        const characters = await HHCache.getCharacterList();
        const currentSystemId = game.system.id;
        const filtered = characters.filter(character => {
            const systemId = character.system_id || character.data?._stats?.systemId;
            return !systemId || systemId === currentSystemId;
        });
        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        // Vault characters that already live in this world (matched via flag)
        const worldActors = new Map();
        for (const actor of game.actors) {
            const characterId = actor.flags?.herohome?.characterid;
            if (characterId && !worldActors.has(characterId)) worldActors.set(characterId, actor);
        }

        const inCampaign = filtered.filter(c => worldActors.has(c.id));
        const notImported = filtered.filter(c => !worldActors.has(c.id));

        // GM only: world actors that came from someone else's vault
        const myIds = new Set(filtered.map(c => c.id));
        const foreignActors = game.user.isGM
            ? Array.from(worldActors.values()).filter(actor => !myIds.has(actor.flags?.herohome?.characterid))
            : [];

        if (!filtered.length && !foreignActors.length) {
            content.html('<p>No characters for this game system found in your vault.</p>'
                + '<p class="herohome-hint">Archived and fallen heroes stay on the website and are not listed here.</p>');
            return;
        }

        const view = HHViewState.view;
        const stack = HHViewState.stack;
        let html = '<div class="herohome-toolbar">'
            + '<span class="herohome-hint">' + inCampaign.length + ' of ' + filtered.length + ' vault heroes are part of this campaign.'
            + (foreignActors.length ? ' &middot; ' + foreignActors.length + ' from other players.' : '') + '</span>'
            + '<span class="herohome-toolbar-buttons">'
            + '<span class="herohome-toggle-group">'
            + '<button type="button" class="herohome-toggle' + (view === 'list' ? ' active' : '') + '" data-hh-view="list" title="List view"><i class="fa-solid fa-table-list"></i></button>'
            + '<button type="button" class="herohome-toggle' + (view === 'grid' ? ' active' : '') + '" data-hh-view="grid" title="Grid view"><i class="fa-solid fa-grip"></i></button>'
            + '</span>'
            + '<span class="herohome-toggle-group">'
            + '<button type="button" class="herohome-toggle' + (stack ? ' active' : '') + '" data-hh-stack title="Group versions of the same hero by name"><i class="fa-solid fa-layer-group"></i></button>'
            + '</span></span></div>';

        if (inCampaign.length) {
            html += '<h1 class="heroHomeSectionHeader">In this Campaign</h1>' + buildVaultListHtml(inCampaign, worldActors);
        }
        if (notImported.length) {
            html += '<h1 class="heroHomeSectionHeader">In your Vault</h1>' + buildVaultListHtml(notImported, worldActors);
        }

        // GM overview: heroes imported from other players' vaults
        if (foreignActors.length) {
            const gridClass = HHViewState.view === 'grid' ? ' herohome-grid' : '';
            const entries = foreignActors.map(actor => {
                const owner = game.users.find(u => !u.isGM && actor.testUserPermission(u, 'OWNER'));
                const ownerPill = owner
                    ? '<span class="herohome-pill herohome-pill-owner" title="Owned by this player">' + owner.name + '</span>'
                    : '<span class="herohome-pill herohome-pill-owner" title="No player owner assigned">unassigned</span>';
                const lastsync = actor.flags?.herohome?.lastsync;
                return `
                    <li class="herohome-character">
                        <img src="${actor.img}" alt="${actor.name}" onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
                        <div class="herohome-character-info">
                            <span class="herohome-character-name">${actor.name}</span>
                            ${ownerPill}
                            <span class="herohome-character-created-at">${lastsync ? 'synced ' + formatDate(lastsync) : 'sync date unknown'}</span>
                        </div>
                        <div class="herohome-character-actions">
                            <button class="herohome-open-actor" title="Open the sheet of ${actor.name}" data-actor-id="${actor.id}"><i class="fa-solid fa-eye"></i></button>
                        </div>
                    </li>
                `;
            }).join('');
            html += '<h1 class="heroHomeSectionHeader">Other Players\' Heroes</h1>'
                + '<ul class="herohome-character-list herohome-import-list' + gridClass + '">' + entries + '</ul>';
        }

        content.html(html);

        content.find('[data-hh-view]').on('click', function () {
            HHViewState.view = $(this).data('hh-view');
            renderHeroHomeCampaignContent();
        });
        content.find('[data-hh-stack]').on('click', function () {
            HHViewState.stack = !HHViewState.stack;
            HHViewState.expanded.clear();
            renderHeroHomeCampaignContent();
        });
        content.find('.herohome-stack-badge').on('click', function (event) {
            event.stopPropagation();
            const key = decodeURIComponent($(this).attr('data-group'));
            if (HHViewState.expanded.has(key)) HHViewState.expanded.delete(key);
            else HHViewState.expanded.add(key);
            renderHeroHomeCampaignContent();
        });
        content.find('.herohome-open-actor').on('click', function () {
            const actor = game.actors.get($(this).data('actor-id'));
            actor?.sheet?.render(true);
        });
        content.find('.herohome-import').on('click', async function () {
            const characterId = $(this).data('character-id');
            $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
            await importCharacterAsNewActor(characterId);
            renderHeroHomeCampaignContent(); // imported hero moves to the campaign section
        });
    } catch (error) {
        console.error('HeroHome | campaign overview error:', error);
        content.html('<p>Could not reach Hero Home. Please try again.</p>');
    }
}

async function openHeroHomeImportPicker() {
    const token = game.settings.get('herohome', 'token');
    if (!token) {
        ui.notifications.warn('HeroHome | Please set your HeroHome token first (open any character sheet and click the HeroHome button).');
        return;
    }

    // Only one import picker at a time (see campaign dialog note)
    if (HeroHome._importScreen) {
        try { HeroHome._importScreen.close(); } catch (e) { /* already closed */ }
    }

    const dialog = new Dialog({
        title: 'Hero Home — Import Character',
        content: '<div class="herohome-dialog-content herohome-import-content">Loading your vault…</div>',
        buttons: {},
    }, { width: 560, height: 680, resizable: true });
    HeroHome._importScreen = dialog;
    // Await the render (see campaign dialog note about the closing animation)
    await dialog._render(true);

    const content = await hhWaitFor('.herohome-import-content');
    if (!content.length) {
        console.error('HeroHome | import picker content element never appeared');
        return;
    }

    try {
        const characters = await HHCache.getCharacterList();
        const currentSystemId = game.system.id;
        const filtered = characters.filter(character => {
            const systemId = character.system_id || character.data?._stats?.systemId;
            return !systemId || systemId === currentSystemId;
        });

        // Newest uploads first
        filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (!filtered.length) {
            content.html('<p>No characters for this game system found in your vault.</p>');
            return;
        }

        const list = $('<ul class="herohome-character-list herohome-import-list"></ul>');
        filtered.forEach(character => {
            list.append(`
                <li class="herohome-character">
                    <img src="${character.image_url}" alt="${character.name}" onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
                    <div class="herohome-character-info">
                        <span class="herohome-character-name">${character.name}</span>
                        ${systemVersionPill(character)}
                        <span class="herohome-character-created-at">${formatDate(character.created_at)}</span>
                    </div>
                    <div class="herohome-character-actions">
                        <button class="herohome-import" title="Import as new actor" data-character-id="${character.id}"><i class="fa-solid fa-file-import"></i></button>
                    </div>
                </li>
            `);
        });

        const content = $('.herohome-import-content');
        content.empty().append(list);
        content.find('.herohome-import').on('click', async function () {
            const characterId = $(this).data('character-id');
            $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
            await importCharacterAsNewActor(characterId);
            dialog.close();
        });
    } catch (error) {
        console.error('HeroHome | import picker error:', error);
        $('.herohome-import-content').html('<p>Could not reach Hero Home. Please try again.</p>');
    }
}

async function importCharacterAsNewActor(characterId) {
    try {
        const token = game.settings.get('herohome', 'token');
        const response = await fetch(`https://herohome.me/api/download_character/${characterId}/`, {
            headers: {
                'Content-Type': 'application/json',
                'Secret-Key': token
            }
        });
        if (!response.ok) {
            ui.notifications.error('HeroHome | Import failed (error ' + response.status + ').');
            return;
        }

        let data = await response.json();
        const serverSync = response.headers.get('X-Herohome-Created-At')
            || data?.flags?.herohome?.lastsync
            || null;

        // Lift older system versions to the current schema before creation
        data = migrateToCurrentSystemVersion(data);
        delete data._id;
        foundry.utils.setProperty(data, 'flags.herohome.characterid', characterId);
        if (serverSync) foundry.utils.setProperty(data, 'flags.herohome.lastsync', serverSync);

        const actor = await Actor.create(data);
        if (actor) {
            // Lift the document onto the current system version (e.g. dnd5e activities)
            await applySystemMigration(actor);
            actor.sheet?.render(true);
            ui.notifications.notify('HeroHome | ' + actor.name + ' has moved in!');
        }
    } catch (error) {
        console.error('HeroHome | import error:', error);
        ui.notifications.error('HeroHome | Import failed — see console for details.');
    }
}

function syncJournalToFallback() {
    const folders = Array.from(game.journal.folders.values()).map(folder => folder.toObject());
    const journalEntries = game.journal.contents.map(j => j.toObject());

    // Create a combined data structure
    const combinedData = {
        folders: folders,
        journalEntries: journalEntries
    };

    // Convert the combined data to a string for transmission
    const dataToSend = JSON.stringify(combinedData);

    // Make an AJAX request to your Django backend
    $.ajax({
        type: 'POST',
        url: 'https://herohome.me/api/worldsync/',
        headers: {
            'Content-Type': 'application/json',
            'Secret-Key': game.settings.get('herohome', 'token')
        },
        data: JSON.stringify({
            foundry_world_id: game.world.id,
            journal_content: dataToSend  // Send the combined data
        }),
        success: function(response) {
            console.log("Successfully synced journals:", response);
        },
        error: function(error) {
            console.error("Error syncing journals:", error);
        }
    });
}
function timeDifference(current, previous) {
    const msPerMinute = 60 * 1000;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    const msPerMonth = msPerDay * 30;
    const msPerYear = msPerDay * 365;

    const elapsed = current - previous;

    if (elapsed < msPerMinute) {
         return Math.round(elapsed/1000) + ' seconds ago';   
    } else if (elapsed < msPerHour) {
         return Math.round(elapsed/msPerMinute) + ' minutes ago';   
    } else if (elapsed < msPerDay ) {
         return Math.round(elapsed/msPerHour ) + ' hours ago';   
    } else if (elapsed < msPerMonth) {
         return Math.round(elapsed/msPerDay) + ' days ago';   
    } else if (elapsed < msPerYear) {
         return Math.round(elapsed/msPerMonth) + ' months ago';   
    } else {
         return Math.round(elapsed/msPerYear ) + ' years ago';   
    }
}
function formatDate(dateString) {
    const date = new Date(dateString);
    if (isNaN(date)) {
        return "This version of the character has not been uploaded yet";
    }
    return timeDifference(new Date(), date);
}

// Small pill showing which system version the stored character data was saved
// with; highlighted when it differs from the running system version.
function systemVersionPill(character) {
    const version = character.system_version || character.data?._stats?.systemVersion;
    if (!version) return '';
    const outdated = version !== game.system.version;
    const cls = outdated ? 'herohome-version-pill outdated' : 'herohome-version-pill';
    const tooltip = outdated
        ? 'Saved with ' + game.system.title + ' v' + version + ' — will be migrated to v' + game.system.version + ' on import'
        : 'Saved with the current system version';
    return '<span class="' + cls + '" title="' + tooltip + '">v' + version + '</span>';
}
function displayCharacterList(characters, currentCharacter, token) {
    const currentSystemId = game.system.id;
    let createdAt = 'Not Uploaded Yet';
    // Target this dialog's own content — the generic .herohome-dialog-content
    // class is shared by every HeroHome dialog (campaign vault, import picker…)
    // and writing through it hits whichever dialog happens to exist.
    let content = $('.herohome-sheet-content').last();
    let dialog = content.closest('.dialog, .application')[0];
    if (!content.length) {
        console.error('HeroHome | sheet dialog content element not found');
        return;
    }

    let synced = currentCharacter.flags.herohome?.synced ?? false;

    let synchedStyle = "hhSynced";
    // Prefer the lightweight system_id field; fall back to the legacy data stub
    const filteredCharacters = characters.filter(character => {
        const systemId = character.system_id || character.data?._stats?.systemId;
        return !systemId || systemId === currentSystemId;
    });

    // Newest uploads first
    filteredCharacters.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if(!synced)synchedStyle = "";
    //Remove old Content
    content.empty();
    let isUploaded = false;
    // Create the character list
    let characterList = $('<ul class="herohome-character-list"></ul>');
    filteredCharacters.forEach((character) => {
        let isCharacter = "";
        let syncClass = "";
        if (character.id === (currentCharacter?.flags?.herohome?.characterid || "")) {
            isCharacter = "hhThisActor"
            isUploaded = true;
            createdAt = character.created_at;
            if(synced)
                syncClass = "hhSynced";
        }
        const characterItem = `
            <li class="herohome-character `+isCharacter+ " " + syncClass+`">
                <img src="${character.image_url}" alt="${character.name}" onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
                <div class="herohome-character-info">
                    <span class="herohome-character-name">${character.name}</span>
                    ${isCharacter ? '<span class="herohome-pill herohome-pill-current">This sheet</span>' : ''}
                    ${systemVersionPill(character)}
                    <span class="herohome-character-created-at">${formatDate(character.created_at)}</span>
                </div>
                <div class="herohome-character-actions">
                    <button class="herohome-download" title="Download this version into the current sheet" data-character-id="${character.id}"><i class="fa-solid fa-cloud-arrow-down"></i></button>
                    <button class="herohome-overwrite" title="Overwrite this vault entry with the current sheet" data-character-id="${character.id}"><i class="fa-solid fa-cloud-arrow-up"></i></button>
                    <button class="herohome-sync `+syncClass+`" disabled data-character-id="${character.id}"><i class="fa-solid fa-rotate"></i></button>
                </div>
            </li>
        `;
        characterList.append(characterItem);
    });


    let isUploadedStyle = 'notUploaded';

    if(isUploaded){
        //let elapsed = moment(createdAt).fromNow();
        isUploadedStyle = 'isUploaded';
    }

    // Create the current character section
    const currentCharacterSection = $('<div class="herohome-current-character '+isUploadedStyle+'" id="'+currentCharacter.id+'"></div>');
    const currentCharacterImage = $(`<img class="herohome-currentCharacterImage" src="${currentCharacter.img}" alt="${currentCharacter.name}">`);
    const characterDetailsDiv = $('<div class="herohome-character-details-div"></div>');
    const characterName = $('<span class="herohome-character-name"></span>').text(currentCharacter.name);
    const characterCreatedAt = $('<span class="herohome-character-created-at"></span>').text(formatDate(createdAt));
    characterDetailsDiv.append(characterName, $('<br>'), characterCreatedAt);
    let syncedSpan = $('<span class="herohome-character-sync"></span>').text("Automatic Sync enabled.");
    if(synced)
        characterDetailsDiv.append(syncedSpan);
        else{
            syncedSpan = $('<span class="herohome-character-sync disabled"></span>').text("Automatic Sync disabled.");
            characterDetailsDiv.append(syncedSpan);
        }
    const characterChangedDiv = $('<div class="herohome-character-changed-div"></div>');
    const uploadButton = $(`<button title="Click to Upload" class="herohome-upload `+isUploadedStyle+`" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-cloud-arrow-up"></i></button>`);
    
    let syncButton = $(`<button title="Click to enable Sync (Automatic Upload)" class="herohome-sync `+synchedStyle+`" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-rotate"></i></button>`);
    if(!isUploaded) syncButton = $(`<button title="You can't sync this character because he hasn't been uploaded yet." disabled class="herohome-sync" data-character-id="${currentCharacter.id}"><i class="fa-solid fa-rotate"></i></button>`);
    
    characterChangedDiv.append(uploadButton, syncButton);
    currentCharacterSection.append(currentCharacterImage, characterDetailsDiv, characterChangedDiv);
    let HeroHome = '<h1 class="heroHomeSectionHeader">Character List:</h1>';

    // Add the new content to the dialog
    content.append(currentCharacterSection,HeroHome,characterList);

    attachButtonListeners(token);
}
async function uploadCharacterImages(characterId, characterImageBlob, tokenImageBlob, actorid) {
    let token = await game.settings.get('herohome', 'token');
    const formData = new FormData();
    formData.append('character_id', characterId);
    formData.append('character_image', characterImageBlob, "character_image.png");
    formData.append('token_image', tokenImageBlob, "token_image.png");

    try {
        const response = await fetch('https://herohome.me/api/upload_character_images/', {
            method: 'POST',
            body: formData,
            headers: {
                'Secret-Key': token,
            },
        });

        if (response.ok) {
            HHCache.invalidate(); // character artwork changed
            const responseData = await response.json();
            const characterImageUrl = responseData.character_image_url;
            const tokenImageUrl = responseData.token_image_url;

            // Assuming you have the actor object available
            const actor = game.actors.get(actorid);
            if (actor) {
                // Update the actor's image paths
                await actor.update({
                    "img": characterImageUrl,
                    "token.img": tokenImageUrl
                });

                ui.notifications.notify("Images uploaded and updated successfully!");
            } else {
                console.error('Error: Actor not found');
            }
        } else {
            console.error('Error:', response.status);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}
function attachButtonListeners(token) {
    $('.herohome-upload').on('click', async function () {
        const characterId = $(this).data('character-id');
        console.log(characterId);
        try {
            const actor = game.actors.get(characterId);
            if (actor) {
                const response = await fetch('https://herohome.me/api/upload_character/', {
                    method: 'POST',
                    body: JSON.stringify(actor),
                    headers: {
                        'Content-Type': 'application/json',
                        'Secret-Key': token,
                    },
                });

                if (response.ok) {
                    HHCache.invalidate(); // vault contents changed
                    ui.notifications.notify("Herohome | " + actor.name + " was successfully uploaded!");
                      const responseData = await response.json();
                      const characterId = responseData.characterid;
                      ui.notifications.notify("CharacterID: " + characterId);
                      actor.update({
                        'flags.herohome.synced': false,
                        'flags.herohome.characterid': characterId
                      });
                       // Fetch and append the character image
                    const characterImageResponse = await fetch(actor.img);
                    const characterImageBlob = await characterImageResponse.blob();
                    
                    // Fetch and append the token image
                    const tokenImageResponse = await fetch(actor.prototypeToken.texture.src);
                    const tokenImageBlob = await tokenImageResponse.blob();
                    await uploadCharacterImages(characterId, characterImageBlob, tokenImageBlob, actor.id);
                    await loadCharacterList(actor);
                } else {
                    console.error('Error:', response.status);
                }
            } else {
                // Handle the case when the actor is not found
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });
    $('.herohome-sync').on('click', async function () {
        const characterId = $(this).data('character-id');
        console.log(characterId);
        const actor = game.actors.get(characterId);
        actor.update({
            'flags.herohome.synced': !actor.flags.herohome.synced,
            'flags.herohome.id': characterId,
        });
        await loadCharacterList(actor);
    });

    async function overwriteCharacter(characterId, data) {
        try {
          const actor = data;
          let token = await game.settings.get('herohome', 'token');
          if (actor) {
            const response = await fetch(
              `https://herohome.me/api/overwrite_character/${characterId}/`,
              {
                method: 'POST',
                body: JSON.stringify(actor),
                headers: {
                  'Content-Type': 'application/json',
                  'Secret-Key': token,
                },
              }
            );
    
            if (response.ok) {
              HHCache.invalidate(); // vault contents changed
              const responseData = await response.json();
              const newCharacterID = responseData.characterid;
              const { created_at } = responseData; // Get the created_at field from the response
              ui.notifications.notify('Character ' + data.name + ' has been synced to HeroHome');
              actor.update({
                'flags.herohome.synced': false,
                'flags.herohome.characterid': newCharacterID,
                'flags.herohome.lastsync': created_at,
              });
              await loadCharacterList(actor);
            } else {
              console.error('Error:', response.status);
            }
          } else {
            // Handle the case when the actor is not found
          }
        } catch (error) {
          console.error('Error:', error);
        }
    }
    
    $('.herohome-overwrite').on('click', async function () {
        const characterId = $(this).data('character-id');
        const actor = game.actors.get($(".herohome-current-character")[0].id);
        if (!actor) return;

        // Compare the vault entry with the sheet so the user notices when they
        // are about to replace a different character.
        let vaultEntry = null;
        try {
            const list = await HHCache.getCharacterList();
            vaultEntry = list.find(c => c.id === characterId) || null;
        } catch (e) { /* confirmation still shown without vault details */ }

        const vaultName = vaultEntry?.name || 'this vault entry';
        const namesDiffer = !!(vaultEntry?.name && actor.name
            && vaultEntry.name.trim().toLowerCase() !== actor.name.trim().toLowerCase());
        const lastUpload = vaultEntry ? formatDate(vaultEntry.created_at) : null;

        const warning = namesDiffer
            ? '<div class="herohome-warning"><i class="fa-solid fa-triangle-exclamation"></i> '
              + 'The vault entry is named "<b>' + vaultEntry.name + '</b>" but your sheet is '
              + '"<b>' + actor.name + '</b>" — you may be replacing a different character!</div>'
            : '';

        new Dialog({
            title: 'Hero Home — Confirm Overwrite',
            content: '<div class="herohome-dialog-content">'
                + '<p>Overwrite the vault entry "<b>' + vaultName + '</b>"'
                + (lastUpload ? ' <span class="herohome-hint">(last upload: ' + lastUpload + ')</span>' : '')
                + ' with the current sheet "<b>' + actor.name + '</b>"?</p>'
                + '<p class="herohome-hint">The stored version will be replaced and cannot be restored.</p>'
                + warning
                + '</div>',
            buttons: {
                yes: {
                    icon: '<i class="fa-solid fa-cloud-arrow-up"></i>',
                    label: 'Overwrite',
                    callback: () => overwriteCharacter(characterId, actor)
                },
                no: {
                    icon: '<i class="fa-solid fa-times"></i>',
                    label: 'Cancel',
                    callback: () => {}
                }
            },
            default: namesDiffer ? 'no' : 'yes'
        }).render(true);
    });

    $('.herohome-download').on('click', async function () {
        const characterId = $(this).data('character-id');
        const actor = game.actors.get($(".herohome-current-character")[0].id);
        if (!actor) return;

        // Compare the vault entry with the local sheet so the user notices
        // when they are about to replace a different character.
        let vaultEntry = null;
        try {
            const list = await HHCache.getCharacterList();
            vaultEntry = list.find(c => c.id === characterId) || null;
        } catch (e) { /* confirmation still shown without vault details */ }

        const vaultName = vaultEntry?.name || 'the vault version';
        const namesDiffer = !!(vaultEntry?.name && actor.name
            && vaultEntry.name.trim().toLowerCase() !== actor.name.trim().toLowerCase());
        const lastUpload = vaultEntry ? formatDate(vaultEntry.created_at) : null;

        const warning = namesDiffer
            ? '<div class="herohome-warning"><i class="fa-solid fa-triangle-exclamation"></i> '
              + 'The vault entry is named "<b>' + vaultEntry.name + '</b>" but your local sheet is '
              + '"<b>' + actor.name + '</b>" — you may be replacing a different character!</div>'
            : '';

        new Dialog({
            title: 'Hero Home — Confirm Download',
            content: '<div class="herohome-dialog-content">'
                + '<p>Replace the local sheet "<b>' + actor.name + '</b>" with the vault version of '
                + '"<b>' + vaultName + '</b>"'
                + (lastUpload ? ' <span class="herohome-hint">(last upload: ' + lastUpload + ')</span>' : '')
                + '?</p>'
                + '<p class="herohome-hint">All items and effects on the local sheet will be replaced. Unsynced local changes are lost.</p>'
                + warning
                + '</div>',
            buttons: {
                yes: {
                    icon: '<i class="fa-solid fa-cloud-arrow-down"></i>',
                    label: 'Download & Replace',
                    callback: () => fetchAndApplyCharacter(characterId, actor, { reloadList: true })
                },
                no: {
                    icon: '<i class="fa-solid fa-times"></i>',
                    label: 'Cancel',
                    callback: () => {}
                }
            },
            default: namesDiffer ? 'no' : 'yes'
        }).render(true);
    });
}
window.HeroHome = class HeroHome {
    static _screen;
    static _campaignScreen;
    static _importScreen;
    static timer = 0;
    static _lastCharacterVersion;

    static startTimer() {
        if(game.user.character)
            this._lastCharacterVersion = JSON.stringify(game.user.character);
            
        this.timerInterval = setInterval(() => {
            // Code to execute every 1 minute
            this.timer++;
            if(game.user.character != null){
                if(game.user.character.flags.herohome?.synced == true){
                   
                    if(game.user.character.flags.herohome?.characterid){
                        if (this._lastCharacterVersion !== JSON.stringify(game.user.character)) {
                            HeroHome.syncCharacter(game.user.character.flags.herohome.characterid, game.user.character);
                        }
                    }
                }
            }
        }, 600000); // 60000 milliseconds = 1 minute
    }

    static stopTimer() {
        clearInterval(this.timerInterval);
    }

    static async syncCharacter(characterId, data) {
        try {
          const actor = data;
          let token = await game.settings.get('herohome', 'token');
          if (actor) {
            const response = await fetch(
              `https://herohome.me/api/overwrite_character/${characterId}/`,
              {
                method: 'POST',
                body: JSON.stringify(actor),
                headers: {
                  'Content-Type': 'application/json',
                  'Secret-Key': token,
                },
              }
            );
    
            if (response.ok) {
                HHCache.invalidate(); // vault contents changed
                const responseData = await response.json();
                const { created_at } = responseData; // Get the created_at field from the response
                await actor.setFlag('herohome', 'lastsync', created_at); // Save the created_at value to actor.flags.herohome.lastsync
                ui.notifications.notify('Character ' + game.user.character.name + ' has been synced to HeroHome');
                this._lastCharacterVersion = JSON.stringify(game.user.character);
            } else {
                console.error('Error:', response.status);
            }
          } else {
            // Handle the case when the actor is not found
          }
        } catch (error) {
          console.error('Error:', error);
        }
    }
    
};