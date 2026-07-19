/**
 * T20 Hayd — Gestão de Party
 * Party Sheet para Tormenta20 (pasta de atores = party), inventário e
 * dinheiro compartilhados, e transferência de itens/dinheiro entre membros.
 */

const MODULE_ID = "t20-hayd-management";

/** Tipos de item que contam como inventário físico no Tormenta20. */
const INVENTORY_TYPES = ["arma", "equipamento", "consumivel", "tesouro"];

/** Tipos de ator que podem ser membros de party. */
const MEMBER_TYPES = ["character", "npc", "simple"];

/** Moedas do sistema (system.dinheiro.*). */
const COINS = ["tl", "to", "tp", "tc"];
const COIN_LABELS = { tl: "TL", to: "TO", tp: "TP", tc: "TC" };
const COIN_NAMES = {
  tl: "THM.CoinTL",
  to: "THM.CoinTO",
  tp: "THM.CoinTP",
  tc: "THM.CoinTC"
};

let socket = null;

const loc = (key, data) =>
  data ? game.i18n.format(key, data) : game.i18n.localize(key);

const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/* ============================================================
   CONFIGURAÇÕES
============================================================ */

function registerSettings() {
  // Registro interno das parties: { [folderId]: { stashActorId } }
  game.settings.register(MODULE_ID, "parties", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "visibility", {
    name: "THM.SettingVisibilityName",
    hint: "THM.SettingVisibilityHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      values: "THM.VisibilityValues",
      percent: "THM.VisibilityPercent",
      hidden: "THM.VisibilityHidden"
    },
    default: "percent",
    onChange: () => refreshPartyApps()
  });

  game.settings.register(MODULE_ID, "requireConfirmation", {
    name: "THM.SettingConfirmName",
    hint: "THM.SettingConfirmHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "chatMode", {
    name: "THM.SettingChatName",
    hint: "THM.SettingChatHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      gm: "THM.ChatGM",
      all: "THM.ChatAll",
      none: "THM.ChatNone"
    },
    default: "gm"
  });

  game.settings.register(MODULE_ID, "lojaCompat", {
    name: "THM.SettingLojaCompatName",
    hint: "THM.SettingLojaCompatHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Controle interno: mensagem de boas-vindas já foi enviada?
  game.settings.register(MODULE_ID, "welcomeShown", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.registerMenu(MODULE_ID, "partyManager", {
    name: "THM.PartyManagerMenuName",
    label: "THM.PartyManagerMenuLabel",
    hint: "THM.PartyManagerMenuHint",
    icon: "fa-solid fa-users-gear",
    type: PartyManagerApp,
    restricted: true
  });
}

/* ============================================================
   PARTIES — pasta de atores + ator-estoque
============================================================ */

function getPartiesSetting() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, "parties") ?? {});
}

/** Ids de pasta de todas as parties cujas pastas ainda existem. */
function getPartyFolderIds() {
  return Object.keys(getPartiesSetting()).filter((id) => game.folders.get(id));
}

/** Ids da pasta da party + todas as subpastas. */
function getFolderSubtreeIds(folderId) {
  const folder = game.folders.get(folderId);
  if (!folder) return new Set();
  const ids = new Set([folder.id]);
  for (const sub of folder.getSubfolders(true)) ids.add(sub.id);
  return ids;
}

function isStashActor(actor) {
  return !!actor?.getFlag(MODULE_ID, "stash");
}

/** Pasta de party à qual o ator-estoque pertence. */
function stashPartyFolderId(actor) {
  return actor?.getFlag(MODULE_ID, "stash") || null;
}

/** Membros da party (atores dentro da pasta/subpastas, exceto o estoque). */
function getMembers(folderId) {
  const ids = getFolderSubtreeIds(folderId);
  if (!ids.size) return [];
  return game.actors
    .filter(
      (a) =>
        a.folder &&
        ids.has(a.folder.id) &&
        MEMBER_TYPES.includes(a.type) &&
        !isStashActor(a)
    )
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Pasta de party que contém o ator (ou null). */
function getPartyFolderIdOf(actor) {
  if (!actor?.folder) return isStashActor(actor) ? stashPartyFolderId(actor) : null;
  for (const folderId of getPartyFolderIds()) {
    if (getFolderSubtreeIds(folderId).has(actor.folder.id)) return folderId;
  }
  return isStashActor(actor) ? stashPartyFolderId(actor) : null;
}

/* ------------------------------------------------------------
   ESTOQUE DA PARTY — guardado como flag na própria pasta.
   Nenhum ator é criado; os itens vivem como dados brutos e o
   dinheiro como números. Toda mutação passa pelo cliente do GM.
------------------------------------------------------------ */

/** Dados do estoque da party: { money: {tl,to,tp,tc}, items: [itemData] }. */
function getStashData(folderId) {
  const folder = game.folders.get(folderId);
  const raw = folder?.getFlag(MODULE_ID, "stash") ?? {};
  return {
    money: Object.fromEntries(COINS.map((k) => [k, Number(raw.money?.[k]) || 0])),
    items: Array.isArray(raw.items) ? foundry.utils.deepClone(raw.items) : []
  };
}

/** (GM) Persiste os dados do estoque na pasta da party. */
async function setStashData(folderId, data) {
  const folder = game.folders.get(folderId);
  if (!folder) throw new Error(loc("THM.InvalidTarget"));
  await folder.update({ [`flags.${MODULE_ID}.stash`]: data });
}

const VOLATILE_ITEM_KEYS = ["qtd", "equipado", "carregado"];

function cleanSystemForMatch(sys) {
  const s = foundry.utils.deepClone(sys ?? {});
  for (const k of VOLATILE_ITEM_KEYS) delete s[k];
  return s;
}

/** Itens idênticos (mesmo tipo/nome/dados, ignorando quantidade e equipado). */
function isSameItem(aData, bData) {
  return (
    aData.type === bData.type &&
    aData.name === bData.name &&
    foundry.utils.objectsEqual(
      cleanSystemForMatch(aData.system),
      cleanSystemForMatch(bData.system)
    )
  );
}

/** Normaliza dados de item para transferência. */
function prepareTransferItemData(sourceData, qty) {
  const data = foundry.utils.deepClone(sourceData);
  delete data.folder;
  delete data.sort;
  data.system ??= {};
  data.system.qtd = qty;
  if (data.system.equipado !== undefined) data.system.equipado = false;
  if (data.system.carregado !== undefined) data.system.carregado = false;
  return data;
}

/** (GM) Adiciona um item ao estoque (empilha se houver idêntico). */
async function stashAddItem(folderId, sourceData, qty) {
  const stash = getStashData(folderId);
  const data = prepareTransferItemData(sourceData, qty);
  const match = stash.items.find((e) => isSameItem(e, data));
  if (match) {
    match.system.qtd = (Number(match.system?.qtd) || 0) + qty;
  } else {
    data._id = foundry.utils.randomID();
    stash.items.push(data);
  }
  await setStashData(folderId, stash);
}

/** (GM) Remove quantidade de um item do estoque; retorna os dados do item. */
async function stashRemoveItem(folderId, entryId, qty) {
  const stash = getStashData(folderId);
  const idx = stash.items.findIndex((e) => e._id === entryId);
  if (idx < 0) throw new Error(loc("THM.ItemNotFound"));
  const entry = foundry.utils.deepClone(stash.items[idx]);
  const have = Number(stash.items[idx].system?.qtd ?? 1) || 0;
  if (qty >= have) stash.items.splice(idx, 1);
  else stash.items[idx].system.qtd = have - qty;
  await setStashData(folderId, stash);
  return entry;
}

/**
 * (GM) Migra estoques antigos (versões anteriores criavam um ator
 * "Inventário — ..." dentro da pasta): move itens e dinheiro para a
 * flag da pasta e apaga o ator.
 */
async function gmMigrateLegacyStashes() {
  const strays = game.actors.filter((a) => stashPartyFolderId(a));
  for (const actor of strays) {
    const folderId = stashPartyFolderId(actor);
    try {
      if (game.folders.get(folderId)) {
        const stash = getStashData(folderId);
        for (const item of actor.items.filter((i) => INVENTORY_TYPES.includes(i.type))) {
          const qty = Number(item.system?.qtd ?? 1) || 1;
          const data = prepareTransferItemData(item.toObject(), qty);
          const match = stash.items.find((e) => isSameItem(e, data));
          if (match) match.system.qtd = (Number(match.system?.qtd) || 0) + qty;
          else {
            data._id = foundry.utils.randomID();
            stash.items.push(data);
          }
        }
        const money = getMoney(actor);
        for (const k of COINS) stash.money[k] += money[k];
        await setStashData(folderId, stash);
      }
      await actor.delete();
      console.log(`${MODULE_ID} | estoque migrado para a pasta ${folderId}`);
    } catch (err) {
      console.error(`${MODULE_ID} | falha ao migrar estoque`, err);
    }
  }

  const parties = getPartiesSetting();
  let changed = false;
  for (const rec of Object.values(parties)) {
    if (rec.stashActorId) {
      delete rec.stashActorId;
      changed = true;
    }
  }
  if (changed) await game.settings.set(MODULE_ID, "parties", parties);
}

/** Parties visíveis para o usuário atual (GM vê todas). */
function getPartiesForUser(user = game.user) {
  const folderIds = getPartyFolderIds();
  if (user.isGM) return folderIds;
  return folderIds.filter((fid) =>
    getMembers(fid).some((a) => a.testUserPermission(user, "OWNER"))
  );
}

/* ============================================================
   DINHEIRO — helpers
============================================================ */

function getMoney(actor) {
  const d = actor?.system?.dinheiro ?? {};
  return Object.fromEntries(COINS.map((k) => [k, Number(d[k]) || 0]));
}

function coinsLabel(coins) {
  const parts = COINS.filter((k) => (Number(coins?.[k]) || 0) > 0).map(
    (k) => `${Number(coins[k])} ${COIN_LABELS[k]}`
  );
  return parts.join(", ");
}

function coinsTotal(coins) {
  return COINS.reduce((t, k) => t + (Number(coins?.[k]) || 0), 0);
}

/**
 * Tibar de Platina (TL) é regra opcional do sistema (flag por ator
 * "sheet.mostrarPlatina"). A party usa platina se algum membro tiver a
 * regra ativada — ou se já houver TL guardado no estoque.
 */
function partyUsesPlatina(folderId) {
  if (getStashData(folderId).money.tl > 0) return true;
  return getMembers(folderId).some(
    (a) => !!a.getFlag("tormenta20", "sheet.mostrarPlatina")
  );
}

/* ============================================================
   COMPATIBILIDADE COM t20-hayd-loja
   O t20-hayd-loja posta no chat toda alteração de system.dinheiro
   (classe CSS "t20-loja-message"), sem oferecer flag de supressão.
   Marcamos os atores envolvidos na transferência (as options do
   update são propagadas a todos os clientes) e bloqueamos a
   criação dessas mensagens numa janela curta.
============================================================ */

const lojaSuppress = new Map(); // actorId -> timestamp

function lojaCompatEnabled() {
  return (
    game.settings.get(MODULE_ID, "lojaCompat") &&
    (game.modules.get("t20-hayd-loja")?.active ?? false)
  );
}

function markLojaSuppress(actorId) {
  if (actorId) lojaSuppress.set(actorId, Date.now());
}

function registerLojaCompatHooks() {
  // As options do update chegam a todos os clientes no hook updateActor;
  // o t20-hayd-loja cria sua mensagem de forma assíncrona, então marcar aqui
  // ainda acontece antes do preCreateChatMessage disparar.
  Hooks.on("updateActor", (actor, data, options) => {
    if (options?.[MODULE_ID]?.suppressLoja) markLojaSuppress(actor.id);
  });

  Hooks.on("preCreateChatMessage", (doc) => {
    if (!lojaCompatEnabled()) return;
    const content = doc.content ?? "";
    if (!content.includes("t20-loja-message")) return;
    const now = Date.now();
    for (const [id, t] of lojaSuppress) {
      if (now - t > 2500) lojaSuppress.delete(id);
    }
    const speakerActor = doc.speaker?.actor;
    if (speakerActor && lojaSuppress.has(speakerActor)) return false;
  });
}

/* ============================================================
   CHAT — registro de transações
============================================================ */

function postTransferChat({ kind, sourceName, targetName, itemName, qty, coins }) {
  const mode = game.settings.get(MODULE_ID, "chatMode");
  if (mode === "none") return;

  const body =
    kind === "item"
      ? loc("THM.ChatItemTransfer", { source: sourceName, target: targetName, item: itemName, qty })
      : loc("THM.ChatMoneyTransfer", { source: sourceName, target: targetName, coins: coinsLabel(coins) });

  const content = `
    <div class="thm-chat-card">
      <div class="thm-chat-header"><i class="fa-solid fa-right-left"></i> ${loc("THM.ChatTransferHeader")}</div>
      <div class="thm-chat-body">${body}</div>
    </div>`;

  const messageData = {
    content,
    speaker: { alias: loc("THM.ChatTransferHeader") },
    flags: { [MODULE_ID]: { transfer: true } }
  };
  if (mode === "gm") {
    messageData.whisper = game.users.filter((u) => u.isGM).map((u) => u.id);
  }
  ChatMessage.create(messageData);
}

/* ============================================================
   MOTOR DE TRANSFERÊNCIAS (executa no cliente do GM)
============================================================ */

function activeOwnerOf(actor, { excludeUserId = null } = {}) {
  return (
    game.users.find(
      (u) =>
        u.active &&
        !u.isGM &&
        u.id !== excludeUserId &&
        actor.testUserPermission(u, "OWNER")
    ) ?? null
  );
}

async function notifyUser(userId, message, type = "info") {
  try {
    if (!userId || userId === game.user.id) {
      ui.notifications[type]?.(message);
      return;
    }
    if (socket) await socket.executeAsUser("notify", userId, message, type);
  } catch (err) {
    console.warn(`${MODULE_ID} | notifyUser`, err);
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

/** Executa no cliente do destinatário: diálogo de aceite. */
async function promptConfirm(data) {
  const fromUser = data.userName
    ? `<p class="thm-hint">${loc("THM.ConfirmFromUser", { user: esc(data.userName) })}</p>`
    : "";
  const content =
    data.kind === "item"
      ? loc("THM.ConfirmItemTransfer", {
          source: data.sourceName,
          target: data.targetName,
          item: data.itemName,
          qty: data.qty
        })
      : loc("THM.ConfirmMoneyTransfer", {
          source: data.sourceName,
          target: data.targetName,
          coins: data.coinsText
        });

  const result = await foundry.applications.api.DialogV2.confirm({
    window: { title: loc("THM.ConfirmTransferTitle"), icon: "fa-solid fa-right-left" },
    content: content + fromUser,
    rejectClose: false,
    modal: true,
    yes: { label: loc("THM.Accept") },
    no: { label: loc("THM.Decline") }
  });
  return result === true;
}

function resolveEndpoint(ep) {
  if (ep?.stashFolderId) {
    return {
      folder: game.folders.get(ep.stashFolderId) ?? null,
      folderId: ep.stashFolderId,
      isStash: true
    };
  }
  if (ep?.tokenUuid) {
    // Token no mapa (cobre tokens não-vinculados, cujo ator é sintético)
    const tokenDoc = fromUuidSync(ep.tokenUuid);
    return { actor: tokenDoc?.actor ?? null, isStash: false };
  }
  return { actor: game.actors.get(ep?.actorId) ?? null, isStash: false };
}

function endpointValid(ep) {
  return ep.isStash ? !!ep.folder : !!ep.actor;
}

/** Endpoint de transferência para um ator (usa o token se for sintético). */
function actorEndpoint(actor) {
  return actor.isToken && actor.token
    ? { tokenUuid: actor.token.uuid }
    : { actorId: actor.id };
}

function userCanActAsSource(user, endpoint) {
  if (user.isGM) return true;
  if (endpoint.isStash) {
    // Qualquer jogador com personagem na party pode mexer no estoque
    return getMembers(endpoint.folderId).some((a) => a.testUserPermission(user, "OWNER"));
  }
  return endpoint.actor.testUserPermission(user, "OWNER");
}

/** Junta dados de item a um ator (empilha se houver um item idêntico). */
async function addItemData(actor, sourceData, qty) {
  const data = prepareTransferItemData(sourceData, qty);
  delete data._id;

  const match = actor.items.find((i) => isSameItem(i.toObject(), data));
  if (match) {
    const current = Number(match.system.qtd ?? 0) || 0;
    await match.update({ "system.qtd": current + qty });
  } else {
    await actor.createEmbeddedDocuments("Item", [data]);
  }
}

async function removeItemQty(item, qty) {
  const have = Number(item.system.qtd ?? 1) || 0;
  if (qty >= have) await item.delete();
  else await item.update({ "system.qtd": have - qty });
}

/**
 * Executa uma transferência. Roda sempre num cliente de GM (direto ou via socket).
 * payload: {
 *   kind: "item" | "money",
 *   source / target: { actorId } | { stashFolderId },
 *   itemId, qty, coins: {tl,to,tp,tc},
 *   userId: iniciador
 * }
 */
async function gmExecuteTransfer(payload) {
  const initiator = game.users.get(payload.userId) ?? null;
  const source = resolveEndpoint(payload.source);
  const target = resolveEndpoint(payload.target);

  const sameEndpoint =
    source.isStash === target.isStash &&
    (source.isStash
      ? source.folderId === target.folderId
      : source.actor?.id === target.actor?.id);
  if (!endpointValid(source) || !endpointValid(target) || sameEndpoint) {
    await notifyUser(payload.userId, loc("THM.InvalidTarget"), "warn");
    return { ok: false, reason: "invalid" };
  }
  if (!initiator || !userCanActAsSource(initiator, source)) {
    await notifyUser(payload.userId, loc("THM.NotAuthorized"), "warn");
    return { ok: false, reason: "unauthorized" };
  }

  const sourceName = source.isStash ? loc("THM.PartyStash") : source.actor.name;
  const targetName = target.isStash ? loc("THM.PartyStash") : target.actor.name;

  // Disponibilidade na origem (reutilizado na revalidação pós-confirmação)
  const findSourceItem = () => {
    if (source.isStash) {
      const entry = getStashData(source.folderId).items.find(
        (e) => e._id === payload.itemId
      );
      return entry
        ? { name: entry.name, have: Number(entry.system?.qtd ?? 1) || 0 }
        : null;
    }
    const it = source.actor.items.get(payload.itemId);
    if (!it || !INVENTORY_TYPES.includes(it.type)) return null;
    return { name: it.name, have: Number(it.system.qtd ?? 1) || 0 };
  };
  const sourceBalance = () =>
    source.isStash ? getStashData(source.folderId).money : getMoney(source.actor);

  // ---------- Validação de disponibilidade ----------
  let qty = 0;
  let coins = null;
  let itemName = "";

  if (payload.kind === "item") {
    const info = findSourceItem();
    if (!info) {
      await notifyUser(payload.userId, loc("THM.ItemNotFound"), "warn");
      return { ok: false, reason: "item-not-found" };
    }
    itemName = info.name;
    qty = Math.floor(Number(payload.qty) || 0);
    if (qty < 1 || qty > info.have) {
      await notifyUser(
        payload.userId,
        loc("THM.NotEnoughQty", { name: sourceName, item: info.name }),
        "warn"
      );
      return { ok: false, reason: "qty" };
    }
  } else if (payload.kind === "money") {
    if (
      (!source.isStash && !source.actor.system?.dinheiro) ||
      (!target.isStash && !target.actor.system?.dinheiro)
    ) {
      await notifyUser(payload.userId, loc("THM.InvalidTarget"), "warn");
      return { ok: false, reason: "invalid" };
    }
    coins = Object.fromEntries(
      COINS.map((k) => [k, Math.max(0, Math.floor(Number(payload.coins?.[k]) || 0))])
    );
    if (coinsTotal(coins) < 1) {
      await notifyUser(payload.userId, loc("THM.NoMoneySelected"), "warn");
      return { ok: false, reason: "no-coins" };
    }
    const balance = sourceBalance();
    if (COINS.some((k) => coins[k] > balance[k])) {
      await notifyUser(payload.userId, loc("THM.NotEnoughMoney", { name: sourceName }), "warn");
      return { ok: false, reason: "funds" };
    }
  } else {
    return { ok: false, reason: "invalid-kind" };
  }

  // ---------- Confirmação do destinatário ----------
  // Alvos fora da party do remetente (ex.: NPCs no mapa) exigem aprovação
  // do GM mesmo com o modo de troca livre ativado.
  const sourcePartyId = source.isStash
    ? source.folderId
    : getPartyFolderIdOf(source.actor);
  const targetIsPartyMember =
    !target.isStash &&
    !!sourcePartyId &&
    getPartyFolderIdOf(target.actor) === sourcePartyId;

  const needsConfirm =
    !initiator.isGM &&
    !target.isStash &&
    !target.actor.testUserPermission(initiator, "OWNER") &&
    (game.settings.get(MODULE_ID, "requireConfirmation") || !targetIsPartyMember);

  if (needsConfirm) {
    const confirmData = {
      kind: payload.kind,
      sourceName,
      targetName,
      itemName,
      qty,
      coinsText: coins ? coinsLabel(coins) : "",
      userName: initiator.name
    };
    const approver = activeOwnerOf(target.actor, { excludeUserId: initiator.id });
    let accepted;
    if (approver) {
      accepted = await withTimeout(
        socket.executeAsUser("promptConfirm", approver.id, confirmData),
        90_000,
        false
      );
    } else {
      // Dono não conectado: o Mestre decide
      accepted = await promptConfirm(confirmData);
    }
    if (!accepted) {
      await notifyUser(
        payload.userId,
        loc("THM.TransferDeclinedBy", { name: approver?.name ?? targetName }),
        "warn"
      );
      return { ok: false, reason: "declined" };
    }

    // Revalida após a espera (o estado pode ter mudado)
    if (payload.kind === "item") {
      const info = findSourceItem();
      if (!info || qty > info.have) {
        await notifyUser(
          payload.userId,
          loc("THM.NotEnoughQty", { name: sourceName, item: itemName }),
          "warn"
        );
        return { ok: false, reason: "qty" };
      }
    } else {
      const balance = sourceBalance();
      if (COINS.some((k) => coins[k] > balance[k])) {
        await notifyUser(payload.userId, loc("THM.NotEnoughMoney", { name: sourceName }), "warn");
        return { ok: false, reason: "funds" };
      }
    }
  }

  // ---------- Execução ----------
  try {
    if (payload.kind === "item") {
      let itemData;
      if (source.isStash) {
        itemData = await stashRemoveItem(source.folderId, payload.itemId, qty);
      } else {
        const it = source.actor.items.get(payload.itemId);
        itemData = it.toObject();
        await removeItemQty(it, qty);
      }
      try {
        if (target.isStash) await stashAddItem(target.folderId, itemData, qty);
        else await addItemData(target.actor, itemData, qty);
      } catch (err) {
        // Devolve à origem se o crédito falhar
        if (source.isStash) await stashAddItem(source.folderId, itemData, qty);
        else await addItemData(source.actor, itemData, qty);
        throw err;
      }
      postTransferChat({ kind: "item", sourceName, targetName, itemName, qty });
    } else {
      const opts = { [MODULE_ID]: { suppressLoja: lojaCompatEnabled() } };
      if (lojaCompatEnabled()) {
        if (!source.isStash) markLojaSuppress(source.actor.id);
        if (!target.isStash) markLojaSuppress(target.actor.id);
      }
      const applyDelta = async (ep, sign) => {
        if (ep.isStash) {
          const stash = getStashData(ep.folderId);
          for (const k of COINS) {
            stash.money[k] = Math.max(0, stash.money[k] + sign * coins[k]);
          }
          await setStashData(ep.folderId, stash);
        } else {
          const balance = getMoney(ep.actor);
          await ep.actor.update(
            Object.fromEntries(
              COINS.map((k) => [
                `system.dinheiro.${k}`,
                Math.max(0, balance[k] + sign * coins[k])
              ])
            ),
            opts
          );
        }
      };
      await applyDelta(source, -1);
      try {
        await applyDelta(target, +1);
      } catch (err) {
        // Reembolsa a origem se o crédito falhar
        await applyDelta(source, +1);
        throw err;
      }
      postTransferChat({ kind: "money", sourceName, targetName, coins });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | transfer`, err);
    await notifyUser(payload.userId, loc("THM.TransferFailed", { reason: err.message }), "error");
    return { ok: false, reason: "error" };
  }

  await notifyUser(payload.userId, loc("THM.TransferDone"), "info");
  return { ok: true };
}

/** Ponto de entrada de qualquer cliente. */
async function requestTransfer(payload) {
  payload.userId = game.user.id;
  if (game.user.isGM) return gmExecuteTransfer(payload);
  if (!game.users.activeGM) {
    ui.notifications.warn(loc("THM.NoGMOnline"));
    return { ok: false, reason: "no-gm" };
  }
  if (!socket) {
    ui.notifications.error(`${MODULE_ID}: socketlib indisponível.`);
    return { ok: false, reason: "no-socket" };
  }
  return socket.executeAsGM("gmExecuteTransfer", payload);
}

/* ============================================================
   DIÁLOGOS
============================================================ */

function memberOptionsHtml(members, { selectedId = null } = {}) {
  return members
    .map(
      (a) =>
        `<option value="a:${a.id}" ${a.id === selectedId ? "selected" : ""}>${esc(a.name)}</option>`
    )
    .join("");
}

function coinInputsHtml(max = null, { showTl = true } = {}) {
  const keys = showTl ? COINS : COINS.filter((k) => k !== "tl");
  return keys.map((k) => {
    const maxAttr = max ? `max="${max[k]}"` : "";
    const maxTxt = max ? ` <span class="thm-hint">(máx. ${max[k]})</span>` : "";
    return `
      <div class="form-group">
        <label>${loc(COIN_NAMES[k])}${maxTxt}</label>
        <input type="number" name="coin-${k}" value="0" min="0" ${maxAttr} step="1" />
      </div>`;
  }).join("");
}

function readCoinsFromForm(form) {
  return Object.fromEntries(
    COINS.map((k) => [k, Math.max(0, Math.floor(Number(form.elements[`coin-${k}`]?.value) || 0))])
  );
}

/** Pergunta a quantidade a enviar (pula o diálogo quando só há 1). */
async function promptQty(itemName, max) {
  if (max <= 1) return 1;
  const result = await foundry.applications.api.DialogV2.wait({
    window: {
      title: loc("THM.SendToTitle", { item: itemName }),
      icon: "fa-solid fa-paper-plane"
    },
    content: `
      <div class="thm-dialog">
        <div class="form-group">
          <label>${loc("THM.SendQty", { max })}</label>
          <input type="number" name="qty" value="1" min="1" max="${max}" step="1" autofocus />
        </div>
      </div>`,
    rejectClose: false,
    buttons: [
      {
        action: "send",
        icon: "fa-solid fa-paper-plane",
        label: loc("THM.Send"),
        default: true,
        callback: (event, button) =>
          Math.floor(Number(button.form.elements.qty.value) || 0)
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: loc("THM.Cancel") }
    ]
  });
  if (result === null || result === "cancel") return null;
  const qty = Number(result);
  if (!(qty >= 1) || qty > max) {
    ui.notifications.warn(loc("THM.InvalidQty"));
    return null;
  }
  return qty;
}

/**
 * Diálogo "Enviar para..." de um item.
 * Origem: { sourceActor } (ficha) OU { stashFolderId } (inventário da party).
 * item: { id, name, maxQty }
 */
async function openSendItemDialog({ sourceActor = null, stashFolderId = null, item }) {
  const fromStash = !!stashFolderId;
  const folderId = fromStash ? stashFolderId : getPartyFolderIdOf(sourceActor);
  if (!folderId) return ui.notifications.warn(loc("THM.NoPartyForUser"));

  const members = getMembers(folderId).filter((a) => a.id !== sourceActor?.id);
  if (!members.length && fromStash) return ui.notifications.warn(loc("THM.NoMembers"));

  const max = Math.max(1, Number(item.maxQty) || 1);
  const stashOption = fromStash
    ? ""
    : `<option value="stash">${loc("THM.PartyStash")}</option>`;

  const content = `
    <div class="thm-dialog">
      <div class="form-group">
        <label>${loc("THM.SendToTarget")}</label>
        <select name="target">${memberOptionsHtml(members)}${stashOption}</select>
      </div>
      <div class="form-group">
        <label>${loc("THM.SendQty", { max })}</label>
        <input type="number" name="qty" value="1" min="1" max="${max}" step="1" />
      </div>
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: loc("THM.SendToTitle", { item: item.name }), icon: "fa-solid fa-paper-plane" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "send",
        icon: "fa-solid fa-paper-plane",
        label: loc("THM.Send"),
        default: true,
        callback: (event, button) => ({
          target: button.form.elements.target.value,
          qty: Math.floor(Number(button.form.elements.qty.value) || 0)
        })
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: loc("THM.Cancel") }
    ]
  });
  if (!result || result === "cancel") return;

  if (result.qty < 1 || result.qty > max) {
    return ui.notifications.warn(
      loc("THM.NotEnoughQty", {
        name: fromStash ? loc("THM.PartyStash") : sourceActor.name,
        item: item.name
      })
    );
  }

  const source = fromStash ? { stashFolderId: folderId } : { actorId: sourceActor.id };
  const target =
    result.target === "stash"
      ? { stashFolderId: folderId }
      : { actorId: result.target.slice(2) };

  await requestTransfer({ kind: "item", source, target, itemId: item.id, qty: result.qty });
}

/** Diálogo genérico de envio de dinheiro. */
async function openMoneyDialog({
  title,
  folderId, // pasta da party (resolve a opção "stash" dos selects)
  sourceChoices = null, // atores quando a origem é selecionável
  fixedSource = null, // endpoint fixo
  targetChoices = null, // membros selecionáveis como destino
  fixedTarget = null,
  maxCoins = null
}) {
  const sourceSelect = sourceChoices
    ? `
      <div class="form-group">
        <label>${loc("THM.SourceChar")}</label>
        <select name="source">${memberOptionsHtml(sourceChoices)}</select>
      </div>`
    : "";

  const targetSelect = targetChoices
    ? `
      <div class="form-group">
        <label>${loc("THM.SendToTarget")}</label>
        <select name="target">${memberOptionsHtml(targetChoices.members)}${targetChoices.includeStash ? `<option value="stash">${loc("THM.PartyStash")}</option>` : ""}</select>
      </div>`
    : "";

  const showTl =
    partyUsesPlatina(folderId) || (Number(maxCoins?.tl) || 0) > 0;

  const content = `
    <div class="thm-dialog">
      ${sourceSelect}
      ${targetSelect}
      <p class="thm-hint">${loc("THM.MoneyHint")}</p>
      ${coinInputsHtml(maxCoins, { showTl })}
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title, icon: "fa-solid fa-coins" },
    content,
    rejectClose: false,
    buttons: [
      {
        action: "send",
        icon: "fa-solid fa-paper-plane",
        label: loc("THM.Send"),
        default: true,
        callback: (event, button) => ({
          source: button.form.elements.source?.value ?? null,
          target: button.form.elements.target?.value ?? null,
          coins: readCoinsFromForm(button.form)
        })
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: loc("THM.Cancel") }
    ]
  });
  if (!result || result === "cancel") return;

  if (coinsTotal(result.coins) < 1) {
    return ui.notifications.warn(loc("THM.NoMoneySelected"));
  }

  const parseChoice = (value) =>
    value === "stash" ? { stashFolderId: folderId } : { actorId: value.slice(2) };

  const source = fixedSource ?? parseChoice(result.source);
  const target = fixedTarget ?? parseChoice(result.target);

  // Validação local de saldo (o GM revalida na execução)
  const srcActor = source.actorId ? game.actors.get(source.actorId) : null;
  const balance = source.stashFolderId
    ? getStashData(source.stashFolderId).money
    : srcActor
      ? getMoney(srcActor)
      : null;
  if (balance && COINS.some((k) => result.coins[k] > balance[k])) {
    return ui.notifications.warn(
      loc("THM.NotEnoughMoney", {
        name: source.stashFolderId ? loc("THM.PartyStash") : srcActor.name
      })
    );
  }

  await requestTransfer({ kind: "money", source, target, coins: result.coins });
}

/** Botão da ficha: enviar dinheiro do personagem para membro ou estoque. */
async function openSendMoneyDialog(actor) {
  const folderId = getPartyFolderIdOf(actor);
  if (!folderId) return ui.notifications.warn(loc("THM.NoPartyForUser"));

  const members = getMembers(folderId).filter(
    (a) => a.id !== actor.id && a.system?.dinheiro
  );

  await openMoneyDialog({
    title: loc("THM.SendMoneyTitle", { name: actor.name }),
    folderId,
    fixedSource: { actorId: actor.id },
    targetChoices: { members, includeStash: true },
    maxCoins: getMoney(actor)
  });
}

/* ============================================================
   PARTY SHEET
============================================================ */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class PartySheetApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, PartySheetApp>} */
  static instances = new Map();

  constructor(folderId, options = {}) {
    super({ ...options, id: `thm-party-${folderId}` });
    this.folderId = folderId;
    this.queueRender = foundry.utils.debounce(() => {
      if (this.rendered) this.render();
    }, 150);
    PartySheetApp.instances.set(folderId, this);
  }

  static DEFAULT_OPTIONS = {
    classes: ["thm-party-sheet"],
    window: {
      icon: "fa-solid fa-users",
      resizable: true,
      controls: [
        {
          icon: "fa-solid fa-users-gear",
          label: "THM.Config",
          action: "openConfig"
        }
      ]
    },
    position: { width: 500, height: 620 },
    actions: {
      changeTab: PartySheetApp.#onChangeTab,
      openActor: PartySheetApp.#onOpenActor,
      depositMoney: PartySheetApp.#onDepositMoney,
      withdrawMoney: PartySheetApp.#onWithdrawMoney,
      sendStashItem: PartySheetApp.#onSendStashItem,
      openConfig: PartySheetApp.#onOpenConfig
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/party-sheet.hbs` }
  };

  tabGroups = { primary: "members" };

  get title() {
    const folder = game.folders.get(this.folderId);
    return `${loc("THM.PartySheet")} — ${folder?.name ?? "?"}`;
  }

  _getHeaderControls() {
    const controls = super._getHeaderControls();
    return game.user.isGM ? controls : controls.filter((c) => c.action !== "openConfig");
  }

  async _prepareContext() {
    const visibility = game.user.isGM
      ? "values"
      : game.settings.get(MODULE_ID, "visibility");

    const members = getMembers(this.folderId).map((a) => {
      const pv = a.system?.attributes?.pv ?? {};
      const pm = a.system?.attributes?.pm ?? {};
      const bar = (res) => {
        const value = Number(res.value) || 0;
        const max = Number(res.max) || 0;
        const pct = max > 0 ? Math.round(Math.clamp((value / max) * 100, 0, 100)) : 0;
        const label = visibility === "values" ? `${value}/${max}` : `${pct}%`;
        return { pct, label };
      };
      const carga = a.system?.attributes?.carga ?? null;
      const cargaData =
        carga && Number(carga.max) > 0
          ? {
              pct: Math.round(Math.clamp(Number(carga.pct) || 0, 0, 100)),
              encumbered: !!carga.encumbered,
              label: loc("THM.EncumbranceLabel", {
                value: Number(carga.value) || 0,
                max: Number(carga.max) || 0,
                limit: Number(carga.limit) || 0
              })
            }
          : null;
      return {
        id: a.id,
        name: a.name,
        img: a.img,
        level: a.type === "character" ? (a.system?.attributes?.nivel?.value ?? null) : null,
        pv: bar(pv),
        pm: bar(pm),
        carga: cargaData
      };
    });

    // Estoque oculto da party (flag na pasta — nenhum ator envolvido)
    const stashData = getStashData(this.folderId);
    const items = stashData.items
      .slice()
      .sort(
        (a, b) =>
          INVENTORY_TYPES.indexOf(a.type) - INVENTORY_TYPES.indexOf(b.type) ||
          a.name.localeCompare(b.name, "pt-BR")
      )
      .map((e) => ({
        id: e._id,
        name: e.name,
        img: e.img,
        qtd: Number(e.system?.qtd ?? 1) || 1,
        typeLabel: game.i18n.localize(CONFIG.Item.typeLabels[e.type] ?? e.type)
      }));

    return {
      tab: this.tabGroups.primary,
      hideBars: visibility === "hidden",
      members,
      items,
      money: stashData.money,
      showTl: partyUsesPlatina(this.folderId)
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    new foundry.applications.ux.ContextMenu.implementation(
      this.element,
      ".thm-inv-item",
      [
        {
          name: loc("THM.SendTo"),
          icon: '<i class="fa-solid fa-paper-plane"></i>',
          callback: (el) => {
            const itemId = el.dataset?.itemId ?? el.closest?.("[data-item-id]")?.dataset.itemId;
            this.#sendStashItem(itemId);
          }
        }
      ],
      { jQuery: false }
    );

    // Arrastar uma linha do inventário da party para fora (ficha de ator)
    this.element.addEventListener("dragstart", (ev) => {
      const row = ev.target?.closest?.(".thm-inv-item");
      if (!row) return;
      ev.dataTransfer.setData(
        "text/plain",
        JSON.stringify({
          type: "Item",
          thmStash: { folderId: this.folderId, entryId: row.dataset.itemId }
        })
      );
    });

    // Soltar um item de ficha aqui dentro = depositar no inventário da party
    this.element.addEventListener("dragover", (ev) => ev.preventDefault());
    this.element.addEventListener("drop", (ev) => this.#onDropIntoSheet(ev));
  }

  async #onDropIntoSheet(event) {
    event.preventDefault();
    const data =
      foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item" || data.thmStash || !data.uuid) return;

    const item = fromUuidSync(data.uuid);
    const actor = item?.parent;
    if (!(actor instanceof Actor) || !INVENTORY_TYPES.includes(item.type)) return;
    if (!actor.isOwner) return;
    if (!game.user.isGM && getPartyFolderIdOf(actor) !== this.folderId) {
      return ui.notifications.warn(loc("THM.NoPartyForUser"));
    }

    const max = Math.max(1, Number(item.system.qtd ?? 1) || 1);
    const qty = await promptQty(item.name, max);
    if (!qty) return;

    await requestTransfer({
      kind: "item",
      source: actorEndpoint(actor),
      target: { stashFolderId: this.folderId },
      itemId: item.id,
      qty
    });
  }

  #sendStashItem(itemId) {
    const entry = getStashData(this.folderId).items.find((e) => e._id === itemId);
    if (!entry) return;
    openSendItemDialog({
      stashFolderId: this.folderId,
      item: {
        id: entry._id,
        name: entry.name,
        maxQty: Number(entry.system?.qtd ?? 1) || 1
      }
    });
  }

  static #onChangeTab(event, target) {
    this.changeTab(target.dataset.tab, target.dataset.group ?? "primary");
  }

  static #onOpenActor(event, target) {
    const actor = game.actors.get(target.dataset.actorId);
    if (!actor) return;
    if (actor.testUserPermission(game.user, "LIMITED")) actor.sheet.render(true);
  }

  static #onDepositMoney() {
    const own = getMembers(this.folderId).filter(
      (a) => a.isOwner && a.system?.dinheiro
    );
    if (!own.length) return ui.notifications.warn(loc("THM.NoPartyForUser"));
    openMoneyDialog({
      title: loc("THM.DepositMoneyTitle"),
      folderId: this.folderId,
      sourceChoices: own,
      fixedTarget: { stashFolderId: this.folderId },
      maxCoins: own.length === 1 ? getMoney(own[0]) : null
    });
  }

  static #onWithdrawMoney() {
    const members = getMembers(this.folderId).filter((a) => a.system?.dinheiro);
    if (!members.length) return ui.notifications.warn(loc("THM.NoMembers"));
    openMoneyDialog({
      title: loc("THM.WithdrawMoneyTitle"),
      folderId: this.folderId,
      fixedSource: { stashFolderId: this.folderId },
      targetChoices: { members, includeStash: false },
      maxCoins: getStashData(this.folderId).money
    });
  }

  static #onSendStashItem(event, target) {
    this.#sendStashItem(target.dataset.itemId);
  }

  static #onOpenConfig() {
    if (game.user.isGM) new PartyManagerApp().render(true);
  }
}

/** Abre a party sheet adequada ao usuário (com escolha se houver várias). */
async function openPartySheet() {
  const folderIds = getPartiesForUser();
  if (!folderIds.length) {
    return ui.notifications.warn(
      loc(game.user.isGM ? "THM.NoPartiesConfigured" : "THM.NoPartyForUser")
    );
  }

  let folderId = folderIds[0];
  if (folderIds.length > 1) {
    const options = folderIds
      .map(
        (fid) =>
          `<option value="${fid}">${esc(game.folders.get(fid)?.name ?? "?")}</option>`
      )
      .join("");
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: loc("THM.ChooseParty"), icon: "fa-solid fa-users" },
      content: `
        <div class="thm-dialog">
          <p class="thm-hint">${loc("THM.ChoosePartyHint")}</p>
          <div class="form-group">
            <select name="party">${options}</select>
          </div>
        </div>`,
      rejectClose: false,
      buttons: [
        {
          action: "open",
          icon: "fa-solid fa-users",
          label: loc("THM.OpenPartySheet"),
          default: true,
          callback: (event, button) => button.form.elements.party.value
        },
        { action: "cancel", icon: "fa-solid fa-xmark", label: loc("THM.Cancel") }
      ]
    });
    if (!choice || choice === "cancel") return;
    folderId = choice;
  }

  const app = PartySheetApp.instances.get(folderId) ?? new PartySheetApp(folderId);
  app.render(true);
}

/** Re-renderiza party sheets abertas quando algo relevante muda. */
function refreshPartyApps(relatedActor = null) {
  for (const app of PartySheetApp.instances.values()) {
    if (!app.rendered) continue;
    if (relatedActor) {
      const fid = getPartyFolderIdOf(relatedActor);
      const isStashOfApp = stashPartyFolderId(relatedActor) === app.folderId;
      if (fid !== app.folderId && !isStashOfApp) continue;
    }
    app.queueRender();
  }
}

/* ============================================================
   GERENCIADOR DE PARTIES (menu de configurações, só GM)
============================================================ */

class PartyManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "thm-party-manager",
    tag: "form",
    classes: ["thm-party-manager", "standard-form"],
    window: { title: "THM.PartyManagerTitle", icon: "fa-solid fa-users-gear" },
    position: { width: 420 },
    form: { handler: PartyManagerApp.#onSubmit, closeOnSubmit: true },
    actions: { createFolder: PartyManagerApp.#onCreateFolder }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/party-manager.hbs` }
  };

  async _preFirstRender(context, options) {
    await super._preFirstRender(context, options);
    // O menu de configurações cria uma instância nova a cada clique;
    // fecha qualquer janela anterior com o mesmo id.
    const existing = foundry.applications.instances.get(this.id);
    if (existing && existing !== this) await existing.close();
  }

  async _prepareContext() {
    const parties = getPartiesSetting();
    const folders = [];
    const walk = (parent, depth) => {
      const children = game.folders
        .filter((f) => f.type === "Actor" && (f.folder?.id ?? null) === parent)
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, "pt-BR"));
      for (const f of children) {
        folders.push({
          id: f.id,
          name: f.name,
          indent: 4 + depth * 16,
          color: f.color?.css ?? "#c9a66b",
          isParty: !!parties[f.id]
        });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return { folders };
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const current = getPartiesSetting();
    const next = {};
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith("party.") || !value) continue;
      const folderId = key.slice(6);
      next[folderId] = current[folderId] ?? {};
    }
    await game.settings.set(MODULE_ID, "parties", next);
    ui.notifications.info(loc("THM.PartiesSaved"));
    refreshPartyApps();
    ui.actors?.render(); // atualiza os botões de party nas pastas
  }

  /** Cria uma nova pasta de atores e já a marca como party. */
  static async #onCreateFolder() {
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: loc("THM.CreateFolderTitle"), icon: "fa-solid fa-folder-plus" },
      content: `
        <div class="thm-dialog">
          <div class="form-group">
            <label>${loc("THM.CreateFolderLabel")}</label>
            <input type="text" name="name" value="${esc(loc("THM.NewPartyName"))}" autofocus />
          </div>
        </div>`,
      ok: {
        label: loc("THM.Create"),
        icon: "fa-solid fa-folder-plus",
        callback: (event, button) => button.form.elements.name.value.trim()
      },
      rejectClose: false
    });
    if (!name) return;

    const folder = await Folder.create({ name, type: "Actor" });
    if (!folder) return;

    const parties = getPartiesSetting();
    parties[folder.id] = parties[folder.id] ?? {};
    await game.settings.set(MODULE_ID, "parties", parties);

    ui.actors?.render();
    refreshPartyApps();
    this.render(); // reflete a nova pasta marcada na lista
  }
}

/** Drop de item do inventário da party sobre uma ficha de ator. */
async function handleStashDropOnActor(actor, { folderId, entryId }) {
  const entry = getStashData(folderId).items.find((e) => e._id === entryId);
  if (!entry) return;
  const canAct =
    game.user.isGM ||
    getMembers(folderId).some((a) => a.testUserPermission(game.user, "OWNER"));
  if (!canAct) return ui.notifications.warn(loc("THM.NotAuthorized"));

  const max = Math.max(1, Number(entry.system?.qtd ?? 1) || 1);
  const qty = await promptQty(entry.name, max);
  if (!qty) return;

  await requestTransfer({
    kind: "item",
    source: { stashFolderId: folderId },
    target: actorEndpoint(actor),
    itemId: entryId,
    qty
  });
}

/** Drop de item da ficha sobre um token no mapa. */
async function handleCanvasItemDrop(sourceActor, item, token) {
  const max = Math.max(1, Number(item.system.qtd ?? 1) || 1);
  const qty = await promptQty(item.name, max);
  if (!qty) return;

  await requestTransfer({
    kind: "item",
    source: actorEndpoint(sourceActor),
    target: { tokenUuid: token.document.uuid },
    itemId: item.id,
    qty
  });
}

/* ============================================================
   INTEGRAÇÕES NA INTERFACE
============================================================ */

function registerUiHooks() {
  // "Enviar para..." no menu de contexto dos itens da ficha (hook do sistema)
  Hooks.on("tormenta20.getItemToggleContextOptions", (item, menuItems) => {
    const actor = item?.actor;
    if (!actor || !INVENTORY_TYPES.includes(item.type)) return;
    if (!actor.isOwner) return;
    if (!getPartyFolderIdOf(actor)) return;
    menuItems.push({
      name: loc("THM.SendTo"),
      icon: '<i class="fa-solid fa-paper-plane"></i>',
      callback: () =>
        openSendItemDialog({
          sourceActor: actor,
          item: {
            id: item.id,
            name: item.name,
            maxQty: Number(item.system.qtd ?? 1) || 1
          }
        })
    });
  });

  // Botão de enviar dinheiro ao lado das moedas da ficha
  Hooks.on("renderActorSheet", (app, html) => {
    const actor = app.actor;
    if (!actor?.system?.dinheiro || !actor.isOwner) return;
    if (!getPartyFolderIdOf(actor)) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;
    for (const currency of root.querySelectorAll("ul.currency")) {
      if (currency.querySelector(".thm-send-money-btn")) continue;
      const li = document.createElement("li");
      li.className = "currency-item thm-send";
      li.innerHTML = `<a class="thm-send-money-btn" data-tooltip="${loc("THM.SendMoney")}"><i class="fa-solid fa-paper-plane"></i></a>`;
      li.querySelector("a").addEventListener("click", (ev) => {
        ev.preventDefault();
        openSendMoneyDialog(actor);
      });
      currency.appendChild(li);
    }
  });

  // Soltar uma linha do inventário da party numa ficha de ator = retirar/enviar
  Hooks.on("dropActorSheetData", (actor, sheet, data) => {
    if (!data?.thmStash) return;
    handleStashDropOnActor(actor, data.thmStash);
    return false; // impede o tratamento padrão do drop
  });

  // Soltar um item da ficha sobre um token no mapa = enviar para aquele ator
  Hooks.on("dropCanvasData", (cv, data) => {
    if (data?.type !== "Item" || !data.uuid || data.thmStash) return;
    const item = fromUuidSync(data.uuid);
    const sourceActor = item?.parent;
    if (!(sourceActor instanceof Actor)) return;
    if (!INVENTORY_TYPES.includes(item.type) || !sourceActor.isOwner) return;

    const token = cv.tokens.placeables.find(
      (t) => t.visible && t.actor && t.bounds.contains(data.x, data.y)
    );
    if (!token || token.actor.uuid === sourceActor.uuid) return;

    handleCanvasItemDrop(sourceActor, item, token);
    return false;
  });

  // Botão "Party" no cabeçalho da pasta de cada party no diretório de atores
  Hooks.on("renderActorDirectory", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    for (const folderId of getPartiesForUser()) {
      const header = root.querySelector(
        `li.folder[data-folder-id="${folderId}"] > header.folder-header`
      );
      if (!header || header.querySelector(".thm-party-btn")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "create-button thm-party-btn icon fa-solid fa-users";
      btn.setAttribute("aria-label", loc("THM.OpenPartySheet"));
      btn.setAttribute("data-tooltip", "");
      btn.addEventListener("click", (ev) => {
        // Impede que o clique também expanda/recolha a pasta
        ev.preventDefault();
        ev.stopPropagation();
        const sheet =
          PartySheetApp.instances.get(folderId) ?? new PartySheetApp(folderId);
        sheet.render(true);
      });
      header.appendChild(btn);
    }
  });

  // Atualização ao vivo das party sheets abertas
  Hooks.on("updateActor", (actor) => refreshPartyApps(actor));
  Hooks.on("createItem", (item) => {
    if (item.parent instanceof Actor) refreshPartyApps(item.parent);
  });
  Hooks.on("updateItem", (item) => {
    if (item.parent instanceof Actor) refreshPartyApps(item.parent);
  });
  Hooks.on("deleteItem", (item) => {
    if (item.parent instanceof Actor) refreshPartyApps(item.parent);
  });
  Hooks.on("createActor", () => refreshPartyApps());
  Hooks.on("deleteActor", () => refreshPartyApps());
  Hooks.on("updateFolder", () => refreshPartyApps());
}

/* ============================================================
   PRIMEIRO USO — mensagem de boas-vindas e abertura do gerenciador
============================================================ */

/** Monta e publica no chat a mensagem explicando o módulo (visível a todos). */
async function postWelcomeMessage() {
  const feature = (icon, title, desc) => `
    <li class="thm-welcome-item">
      <i class="fa-solid ${icon}"></i>
      <div><strong>${loc(title)}</strong> — ${loc(desc)}</div>
    </li>`;

  const content = `
    <div class="thm-chat-card thm-welcome">
      <div class="thm-chat-header">
        <i class="fa-solid fa-users"></i> ${loc("THM.WelcomeTitle")}
      </div>
      <div class="thm-chat-body">
        <p>${loc("THM.WelcomeIntro")}</p>
        <ul class="thm-welcome-list">
          ${feature("fa-users", "THM.WelcomePartyBtnTitle", "THM.WelcomePartyBtnDesc")}
          ${feature("fa-heart-pulse", "THM.WelcomeMembersTitle", "THM.WelcomeMembersDesc")}
          ${feature("fa-box-open", "THM.WelcomeInventoryTitle", "THM.WelcomeInventoryDesc")}
          ${feature("fa-paper-plane", "THM.WelcomeSendItemTitle", "THM.WelcomeSendItemDesc")}
          ${feature("fa-coins", "THM.WelcomeSendMoneyTitle", "THM.WelcomeSendMoneyDesc")}
          ${feature("fa-hand", "THM.WelcomeDragTitle", "THM.WelcomeDragDesc")}
          ${feature("fa-gear", "THM.WelcomeSettingsTitle", "THM.WelcomeSettingsDesc")}
        </ul>
        <p class="thm-hint">${loc("THM.WelcomeGmTip")}</p>
      </div>
    </div>`;

  await ChatMessage.create({
    content,
    speaker: { alias: loc("THM.ModuleTitle") },
    flags: { [MODULE_ID]: { welcome: true } }
  });
}

/**
 * Executado no ready pelo GM principal:
 *  - envia a mensagem de boas-vindas uma única vez;
 *  - se nenhuma pasta de party estiver configurada, abre o gerenciador
 *    (tanto no primeiro uso quanto nos seguintes).
 */
async function runFirstUseFlow() {
  if (!game.settings.get(MODULE_ID, "welcomeShown")) {
    await postWelcomeMessage();
    await game.settings.set(MODULE_ID, "welcomeShown", true);
  }

  if (getPartyFolderIds().length === 0) {
    new PartyManagerApp().render(true);
  }
}

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("gmExecuteTransfer", gmExecuteTransfer);
  socket.register("promptConfirm", promptConfirm);
  socket.register("notify", (message, type) => ui.notifications[type]?.(message));
});

Hooks.once("init", () => {
  registerSettings();
  registerLojaCompatHooks();
  registerUiHooks();
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openPartySheet,
    requestTransfer,
    PartySheetApp,
    PartyManagerApp
  };

  // Migra estoques criados como ator pela versão anterior (só um GM executa)
  if (game.user.isGM && game.user === game.users.activeGM) {
    gmMigrateLegacyStashes();
  }

  // Boas-vindas + abertura do gerenciador quando não há party (só o GM principal)
  if (game.user.isGM && game.user === game.users.activeGM) {
    runFirstUseFlow();
  }

  console.log(`${MODULE_ID} | pronto`);
});
