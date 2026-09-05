const crypto = require("crypto");
const dataStore = require("./dataStore.js");
const logger = require("./logger.js");
const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");

const warnedInvalidNotifications = new Set();
const RESULT_REPORT_TYPES = new Set(["result", "result_corrected", "result_cleared", "match_end_corrected"]);
const CHALLENGE_REPORT_TYPES = new Set(["challenge", "challenge_confirmation"]);
const DATE_CHANGE_REPORT_TYPES = new Set(["appointment_changed", "ranking_challenge_date_changed", "ranking_match_date_admin_changed", "match_end_corrected"]);
const VIENNA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna", year: "numeric", month: "2-digit", day: "2-digit" });

function viennaDay(timestamp) {
  const parts = Object.fromEntries(VIENNA_DAY.formatToParts(new Date(timestamp)).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reportCategory(type) {
  return {
    result: RESULT_REPORT_TYPES.has(type),
    challenge: CHALLENGE_REPORT_TYPES.has(type),
    dateChange: DATE_CHANGE_REPORT_TYPES.has(type),
  };
}

function notificationChannels(value, { personId = "", rowNumber = 0, log = logger.log } = {}) {
  const raw = String(value || "");
  if (!raw) return [];
  const channels = raw.split("|");
  if (channels.some((channel) => !["Email", "Whatsapp"].includes(channel)) || new Set(channels).size !== channels.length) {
    const warningKey = `${personId}:${rowNumber}`;
    if (!warnedInvalidNotifications.has(warningKey)) {
      warnedInvalidNotifications.add(warningKey);
      log("warn", "player_notification_channels_invalid", { personId, rowNumber, reason: "INVALID_NOTIFICATION_CHANNELS" });
    }
    return [];
  }
  return channels;
}

function stableId(prefix, identity) {
  return `${prefix}-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function rankedName(name, rank) {
  return Number.isInteger(rank) && rank >= 0 ? `${name} (${rank})` : name;
}

function competitionRoundName(value) {
  const code = String(value || "").trim().toUpperCase().match(/^(R\d+|AF|VF|HF|F|G\d+)/)?.[1] || "";
  if (/^R\d+$/.test(code)) return `${code.slice(1)}. Runde`;
  if (code === "AF") return "Achtelfinale";
  if (code === "VF") return "Viertelfinale";
  if (code === "HF") return "Halbfinale";
  if (code === "F") return "Finale";
  if (/^G\d+$/.test(code)) return `${code.slice(1)}. Gruppe`;
  return "";
}

function appointmentText(value) {
  const match = String(value || "").match(/^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!match) throw new AppError("MATCH_DATE_INVALID", "Spieltermin ist ungueltig", 400);
  const century = Number(match[1]) >= 50 ? "19" : "20";
  return `${match[3]}.${match[2]}.${century}${match[1]}, ${match[4]}:${match[5]} Uhr`;
}

class MessagingService {
  constructor({ repository, emailAdapter, whatsappAdapter, publish = () => {}, now = Date.now, log = logger.log }) {
    this.repository = repository;
    this.adapters = { Email: emailAdapter, Whatsapp: whatsappAdapter };
    this.publish = publish;
    this.now = now;
    this.log = log;
    this.legacyEnrichmentResult = null;
  }

  person(personId) {
    const values = dataStore.get("players");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const rowOffset = values.slice(1).findIndex((entry) => String(entry[idIndex] || "").trim() === String(personId));
    if (rowOffset < 0) throw new AppError("PERSON_NOT_FOUND", "Person wurde nicht gefunden", 404);
    const row = values[rowOffset + 1];
    const notificationIndex = headerIndex(header, "notification");
    return { channels: notificationIndex < 0 ? [] : notificationChannels(row[notificationIndex], { personId: String(personId), rowNumber: rowOffset + 2, log: this.log }) };
  }

  activeAdministrators() {
    const values = dataStore.get("players");
    const header = headerOf(values);
    const indexes = {
      id: headerIndex(header, "id"),
      firstName: headerIndex(header, "vorname"),
      lastName: headerIndex(header, "nachname"),
      active: headerIndex(header, "aktiv"),
      role: headerIndex(header, "role"),
    };
    return values.slice(1).flatMap((row) => {
      const id = String(row[indexes.id] || "").trim();
      const active = indexes.active < 0 || String(row[indexes.active] || "").trim() === "1";
      const role = indexes.role < 0 ? "player" : String(row[indexes.role] || "").trim().toLowerCase();
      if (!id || !active || role !== "admin") return [];
      const name = [row[indexes.firstName], row[indexes.lastName]].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
      return [{ id, name: name || id }];
    });
  }

  participant({ identity, userId, role, displayName = "", type, subject, body, allowMissingPerson = false }) {
    let external = [];
    try {
      external = this.person(userId).channels;
    } catch (error) {
      if (!allowMissingPerson || error.code !== "PERSON_NOT_FOUND") throw error;
    }
    return {
      userId, role, displayName, messageId: stableId("msg", identity), type, subject, body,
      deliveries: [{ channel: "Inbox", status: "delivered" }, ...external.map((channel) => ({ channel, status: "pending" }))],
    };
  }

  async ensureEvent(event, participants) {
    const outcome = this.repository.ensureEvent(event, participants);
    this.log("info", "competition_event_persistence_completed", {
      eventId: event.id,
      competitionId: event.competitionId || "",
      eventType: event.type,
      participantCount: participants.length,
      inserted: outcome.inserted,
    });
    for (const delivery of this.repository.pendingDeliveries(event.id)) {
      let status = "failed";
      try {
        const result = await this.adapters[delivery.channel]?.send({ messageId: delivery.messageId, recipientId: delivery.userId });
        if (["delivered", "failed", "not_configured"].includes(result?.status)) status = result.status;
      } catch (error) {
        this.log("warn", "message_external_delivery_failed", { messageId: delivery.messageId, recipientId: delivery.userId, channel: delivery.channel, errorCode: error.code || "EXTERNAL_DELIVERY_FAILED" });
      }
      try {
        this.repository.updateDelivery(event.id, delivery.userId, delivery.channel, status);
      } catch (error) {
        this.log("warn", "message_delivery_status_persistence_failed", { messageId: delivery.messageId, recipientId: delivery.userId, channel: delivery.channel, errorCode: error.code || "MESSAGING_WRITE_FAILED" });
      }
    }
    if (outcome.inserted) for (const participant of participants) this.publishSummary(participant.userId);
    return this.repository.getEvent(event.id);
  }

  async ensureMessage({ identity, recipientId, createdAt, subject, body, type, matchId, actorId, competitionId = null }) {
    const participant = this.participant({ identity, userId: recipientId, role: "recipient", type, subject, body });
    const event = await this.ensureEvent({ id: participant.messageId, competitionId, createdAt, type, source: "match", sourceId: matchId, actorId, actorName: "", summary: subject, detail: "" }, [participant]);
    return event.participants[0];
  }

  ensureChallengeMessage({ matchId, recipientId, competitionId = null, competitionName, challengerId, challengerName, createdAt = this.now() }) {
    return this.ensureMessage({ identity: `challenge:${matchId}`, recipientId, competitionId, createdAt, subject: `Neue Forderung in ${competitionName}`, body: `${challengerName || challengerId} hat dich gefordert. Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen.`, type: "challenge", matchId, actorId: challengerId });
  }

  ensureChallengeConfirmation({ matchId, challengerId, opponentId, opponentName, competitionId = null, competitionName, createdAt = this.now() }) {
    return this.ensureMessage({ identity: `challenge-confirmation:${matchId}`, recipientId: challengerId, competitionId, createdAt, subject: `Forderung ausgesprochen in ${competitionName}`, body: `Du hast ${opponentName || opponentId} in ${competitionName} gefordert. Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen.`, type: "challenge_confirmation", matchId, actorId: challengerId });
  }

  async ensureChallengeEvent({ matchId, recipientId, competitionId = null, competitionName, challengerId, challengerName, challengerRank = null, opponentId = recipientId, opponentName, opponentRank = null, createdAt = this.now() }) {
    const challengerDisplay = rankedName(challengerName || challengerId, challengerRank);
    const opponentDisplay = rankedName(opponentName || opponentId, opponentRank);
    const participants = [
      this.participant({ identity: `challenge:${matchId}`, userId: recipientId, role: "opponent", displayName: opponentName || opponentId, type: "challenge", subject: `Neue Forderung in ${competitionName}`, body: `${challengerName || challengerId} hat dich gefordert. Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen.` }),
      this.participant({ identity: `challenge-confirmation:${matchId}`, userId: challengerId, role: "challenger", displayName: challengerName || challengerId, type: "challenge_confirmation", subject: `Forderung ausgesprochen in ${competitionName}`, body: `Du hast ${opponentName || opponentId} in ${competitionName} gefordert. Bitte vereinbart einen Spieltermin in den kommenden sieben Tagen.` }),
    ];
    const event = await this.ensureEvent({
      id: stableId("evt", `challenge:${matchId}`),
      competitionId,
      createdAt,
      type: "challenge",
      source: "match",
      sourceId: matchId,
      actorId: challengerId,
      actorName: challengerName || challengerId,
      summary: `${challengerDisplay} hat ${opponentDisplay} gefordert.`,
      detail: "Die Beteiligten sollen innerhalb der kommenden sieben Tage einen Spieltermin vereinbaren.",
    }, participants);
    return { event, recipient: event.participants.find(({ recipient }) => recipient === recipientId), challenger: event.participants.find(({ recipient }) => recipient === challengerId) };
  }

  ensureChallengeMessages(params) {
    return this.ensureChallengeEvent(params);
  }

  async ensureMatchAppointmentEvent({ operationId, matchId, matchDate, previousDate = "", competitionId, competitionName, challengerId, challengerName, opponentId, opponentName, actorId, actorName, createdAt = this.now() }) {
    const identity = `appointment:${matchId}:${operationId}`;
    const dateText = appointmentText(matchDate);
    const previousDateText = previousDate ? appointmentText(previousDate) : "";
    const changed = Boolean(previousDateText);
    const participants = [
      this.participant({ identity: `${identity}:${challengerId}`, userId: challengerId, role: "challenger", displayName: challengerName, type: changed ? "appointment_changed" : "appointment", subject: `${changed ? "Spieltermin geändert" : "Spieltermin festgelegt"} mit ${opponentName}`, body: changed ? `Der Termin für dein Match gegen ${opponentName} wurde von ${previousDateText} auf ${dateText} geändert.` : `Dein Match gegen ${opponentName} ist für den ${dateText} geplant.` }),
      this.participant({ identity: `${identity}:${opponentId}`, userId: opponentId, role: "opponent", displayName: opponentName, type: changed ? "appointment_changed" : "appointment", subject: `${changed ? "Spieltermin geändert" : "Spieltermin festgelegt"} mit ${challengerName}`, body: changed ? `Der Termin für dein Match gegen ${challengerName} wurde von ${previousDateText} auf ${dateText} geändert.` : `Dein Match gegen ${challengerName} ist für den ${dateText} geplant.` }),
    ];
    const event = await this.ensureEvent({
      id: stableId("evt", identity),
      competitionId,
      createdAt,
      type: changed ? "appointment_changed" : "appointment",
      source: "match",
      sourceId: matchId,
      actorId,
      actorName,
      summary: changed
        ? `Spieltermin für ${challengerName} gegen ${opponentName} von ${previousDateText} auf ${dateText} geändert.`
        : `${challengerName} und ${opponentName} haben den Spieltermin für den ${dateText} vereinbart.`,
      detail: changed ? `Alter Spieltermin: ${previousDateText}; neuer Spieltermin: ${dateText}` : `Spieltermin: ${dateText}`,
    }, participants);
    return { event, participants: event.participants };
  }

  async ensureMatchResultEvent({ operationId, matchId, competitionId, competitionName, roundCode = "", participantIds, participantNames = {}, actorId, actorName, changeType, completionType = "", result = "", matchEnd = "", reason = "", createdAt = this.now() }) {
    const types = {
      result: "result",
      result_corrected: "result_corrected",
      result_cleared: "result_cleared",
      match_end_corrected: "match_end_corrected",
    };
    const type = types[changeType];
    if (!type) throw new AppError("MESSAGING_EVENT_INVALID", "Ergebnisereignis ist ungueltig", 500);
    const uniqueIds = [...new Set((participantIds || []).map(String).filter(Boolean))];
    if (!uniqueIds.length) throw new AppError("MESSAGING_EVENT_INVALID", "Ergebnisereignis besitzt keine Teilnehmer", 500);
    const identity = `match-result:${changeType}:${matchId}:${operationId}`;
    const labels = {
      result: "Ergebnis eingetragen",
      result_corrected: "Ergebnis korrigiert",
      result_cleared: "Ergebnis zurückgenommen",
      match_end_corrected: "Matchende korrigiert",
    };
    const controlledResult = changeType === "result_cleared" ? "" : String(result || "");
    const detailParts = [completionType ? `Abschlussart: ${completionType}` : "", controlledResult ? `Ergebnis: ${controlledResult}` : "", matchEnd ? `Matchende: ${matchEnd}` : "", reason ? `Grund: ${reason}` : ""].filter(Boolean);
    const participants = uniqueIds.map((userId) => this.participant({
      identity: `${identity}:${userId}`,
      userId,
      role: "participant",
      displayName: participantNames[userId] || userId,
      type,
      subject: `${labels[changeType]}: ${competitionName}`,
      body: `${actorName || actorId} hat das Matchergebnis ${changeType === "result" ? "eingetragen" : changeType === "result_cleared" ? "zurückgenommen" : "korrigiert"}.${controlledResult ? ` Ergebnis: ${controlledResult}.` : ""}${reason ? ` Grund: ${reason}` : ""}`,
      allowMissingPerson: true,
    }));
    const event = await this.ensureEvent({
      id: stableId("evt", identity),
      competitionId,
      createdAt,
      type,
      source: "match",
      sourceId: matchId,
      actorId,
      actorName,
      summary: `${labels[changeType]} für ${uniqueIds.map((id) => participantNames[id] || id).join(" / ")}.`,
      detail: detailParts.join("; "),
      result: controlledResult,
      roundName: competitionRoundName(roundCode),
      completionType,
    }, participants);
    return { event, participants: event.participants };
  }

  async ensureMissingKoTargetEvent({ operationId, matchId, competitionName, roundCode = "", expectedRoundCode, actorId, actorName, createdAt = this.now() }) {
    const administrators = this.activeAdministrators();
    if (!administrators.length) {
      this.log("warn", "ko_progression_admin_notification_skipped", {
        matchId,
        expectedRoundCode,
        reason: "NO_ACTIVE_ADMINISTRATORS",
      });
      return { event: null, participants: [] };
    }
    const identity = `ko-target-missing:${matchId}:${operationId}`;
    const sourceRound = competitionRoundName(roundCode) || roundCode || "unbekannte Runde";
    const expectedRound = competitionRoundName(expectedRoundCode) || expectedRoundCode;
    const subject = `KO-Fortschreibung erforderlich: ${competitionName}`;
    const body = `Das Ergebnis für Match ${matchId} (${sourceRound}) wurde gespeichert, aber das Folgematch ${expectedRound} fehlt. Bitte das KO-Raster ergänzen und die Gewinnerseite übernehmen.`;
    const participants = administrators.map(({ id, name }) => this.participant({
      identity: `${identity}:${id}`,
      userId: id,
      role: "administrator",
      displayName: name,
      type: "ko_progression_required",
      subject,
      body,
    }));
    const event = await this.ensureEvent({
      id: stableId("evt", identity),
      competitionId: null,
      createdAt,
      type: "ko_progression_required",
      source: "system",
      sourceId: matchId,
      actorId,
      actorName,
      summary: subject,
      detail: "",
    }, participants);
    return { event, participants: event.participants };
  }

  async ensureAdminRankingChallengeEvent({ action, operationId, matchId, competitionId, challengerId, challengerName, opponentId, opponentName, actorId, actorName, reason, previousDate = "", nextDate = "", createdAt = this.now() }) {
    const identity = `ranking-admin:${action}:${matchId}:${operationId}`;
    const previousText = previousDate ? appointmentText(previousDate) : "";
    const nextText = nextDate ? appointmentText(nextDate) : "";
    const labels = {
      deleted: {
        type: "ranking_challenge_deleted",
        subject: "Forderung gelöscht",
        summary: `Forderung zwischen ${challengerName} und ${opponentName} gelöscht.`,
      },
      challenge_date_changed: {
        type: "ranking_challenge_date_changed",
        subject: "Forderungsdatum geändert",
        summary: `Forderungsdatum für ${challengerName} gegen ${opponentName} von ${previousText} auf ${nextText} geändert.`,
      },
      match_date_changed: {
        type: "ranking_match_date_admin_changed",
        subject: previousText ? "Spieldatum geändert" : "Spieldatum festgelegt",
        summary: previousText
          ? `Spieldatum für ${challengerName} gegen ${opponentName} von ${previousText} auf ${nextText} geändert.`
          : `Spieldatum für ${challengerName} gegen ${opponentName} auf ${nextText} festgelegt.`,
      },
    };
    const label = labels[action];
    if (!label) throw new AppError("MESSAGING_EVENT_INVALID", "Adminaktion fuer Ranglistenforderung ist ungueltig", 500);
    const body = (otherName, role) => {
      const change = action === "deleted"
        ? `die Forderung ${role === "challenger" ? "gegen" : "von"} ${otherName} gelöscht`
        : action === "challenge_date_changed"
          ? `das Forderungsdatum der Forderung mit ${otherName} von ${previousText} auf ${nextText} geändert`
          : previousText
            ? `das Spieldatum der Forderung mit ${otherName} von ${previousText} auf ${nextText} geändert`
            : `für die Forderung mit ${otherName} das Spieldatum ${nextText} festgelegt`;
      return `Administrator ${actorName} hat ${change}. Grund: ${reason}`;
    };
    const subject = (otherName, role) => action === "deleted"
      ? `Forderung ${role === "challenger" ? "gegen" : "von"} ${otherName} gelöscht`
      : `${label.subject} mit ${otherName}`;
    const participants = [
      this.participant({ identity: `${identity}:${challengerId}`, userId: challengerId, role: "challenger", displayName: challengerName, type: label.type, subject: subject(opponentName, "challenger"), body: body(opponentName, "challenger"), allowMissingPerson: true }),
      this.participant({ identity: `${identity}:${opponentId}`, userId: opponentId, role: "opponent", displayName: opponentName, type: label.type, subject: subject(challengerName, "opponent"), body: body(challengerName, "opponent"), allowMissingPerson: true }),
    ];
    const event = await this.ensureEvent({
      id: stableId("evt", identity),
      competitionId,
      createdAt,
      type: label.type,
      source: "match",
      sourceId: matchId,
      actorId,
      actorName,
      summary: label.summary,
      detail: `Grund: ${reason}`,
    }, participants);
    return { event, participants: event.participants };
  }

  async ensureRankingWithdrawalEvent({ competitionId, competitionName, participantId, participantName = participantId, actorId = participantId, actorName = participantName, operationId, reason = "", createdAt = this.now() }) {
    const identity = `ranking-withdrawal:${competitionId}:${participantId}:${operationId || createdAt}`;
    const detail = reason ? `Grund: ${reason}` : "";
    const participant = this.participant({ identity, userId: participantId, role: "withdrawn", displayName: participantName, type: "ranking_withdrawal", subject: `Aus Rangliste ${competitionName} rausgehängt`, body: `Du hast dich aus der Rangliste ${competitionName} rausgehängt.${detail ? ` ${detail}` : ""}` });
    const event = await this.ensureEvent({
      id: stableId("evt", identity),
      competitionId,
      createdAt,
      type: "ranking_withdrawal",
      source: "ranking",
      sourceId: operationId || competitionId,
      actorId,
      actorName,
      summary: `${participantName} hat sich aus der Rangliste rausgehängt.`,
      detail: "",
    }, [participant]);
    return { event, message: event.participants[0] };
  }

  enrichLegacyCompetitionAssignments() {
    if (this.legacyEnrichmentResult) return this.legacyEnrichmentResult;
    const values = dataStore.get("matches1");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const competitionIndex = headerIndex(header, "bewerbid");
    if (idIndex < 0 || competitionIndex < 0) return { checked: 0, matched: 0 };
    let checked = 0;
    let matched = 0;
    for (const row of values.slice(1)) {
      const matchId = String(row[idIndex] || "").trim();
      const competitionId = String(row[competitionIndex] || "").trim();
      if (!matchId || !competitionId) continue;
      checked++;
      matched += this.repository.enrichCompetitionByMatchId(matchId, competitionId).matched;
    }
    this.legacyEnrichmentResult = { checked, matched };
    this.log("info", "legacy_competition_event_enrichment_completed", this.legacyEnrichmentResult);
    return this.legacyEnrichmentResult;
  }

  competitionHistory(_principal, { bewerbId, cursor = null, limit = 50 }) {
    const values = dataStore.get("bewerbe");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const nameIndex = headerIndex(header, "bezeichnung");
    const typeIndex = headerIndex(header, "bewerbsartid");
    const competitions = new Map(values.slice(1).map((row) => [
      String(row[idIndex] || "").trim(),
      String(row[nameIndex] || "").trim(),
    ]).filter(([id]) => id));
    const rankingCompetitionIds = new Set(values.slice(1).flatMap((row) => (
      String(row[typeIndex] || "").trim() === "2" ? [String(row[idIndex] || "").trim()] : []
    )).filter(Boolean));
    if (bewerbId && !competitions.has(bewerbId)) throw new AppError("COMPETITION_NOT_FOUND", "Bewerb wurde nicht gefunden", 404);
    this.enrichLegacyCompetitionAssignments();
    const page = this.repository.pageCompetitionHistory(bewerbId || null, { cursor, limit });
    const rounds = this.matchRoundNames();
    return {
      success: true,
      competition: bewerbId
        ? { id: bewerbId, name: competitions.get(bewerbId) }
        : { id: "", name: "Alle Bewerbe" },
      entries: page.events.map((event) => ({
        id: event.id,
        competitionId: event.competitionId,
        competitionName: competitions.get(event.competitionId) || `Bewerb ${event.competitionId}`,
        roundName: event.source === "match" && !rankingCompetitionIds.has(event.competitionId) ? rounds.get(event.sourceId) || "" : "",
        type: event.type,
        occurredAt: event.createdAt,
        summary: event.summary,
        detail: event.detail,
        result: event.result,
        actorName: event.actorName,
        participants: event.participants.map(({ participantRole, displayName }) => ({ role: participantRole, name: displayName })),
      })),
      nextCursor: page.nextCursor,
    };
  }

  reportingPeople() {
    const values = dataStore.get("players");
    const header = headerOf(values);
    const indexes = {
      id: headerIndex(header, "id"),
      firstName: headerIndex(header, "vorname"),
      lastName: headerIndex(header, "nachname"),
      role: headerIndex(header, "role"),
    };
    return new Map(values.slice(1).flatMap((row) => {
      const id = String(row[indexes.id] || "").trim();
      if (!id) return [];
      const rawRole = indexes.role < 0 ? "player" : String(row[indexes.role] || "player").trim();
      const normalizedRole = rawRole.toLowerCase();
      const role = normalizedRole === "player a" ? "player A" : normalizedRole === "player b" ? "player B" : normalizedRole;
      const recipientClass = ["player", "player A", "player B"].includes(role) ? "Spieler" : role === "admin" ? "Administratoren" : "Andere/Unbekannt";
      const name = [row[indexes.firstName], row[indexes.lastName]].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
      return [[id, { role, recipientClass, name }]];
    }));
  }

  messagingReport({ fromMs, toMs, deployment }) {
    const startedAt = this.now();
    try {
      if (!dataStore.getMeta("players")?.lastUpdate || !dataStore.getMeta("bewerbe")?.lastUpdate) {
        throw new AppError("DATA_NOT_READY", "Meldungsbericht wartet auf aktuelle Grunddaten", 503);
      }
      const projections = this.repository.reportProjections(fromMs, toMs);
      const people = this.reportingPeople();
      const competitions = new Map();
      const competitionValues = dataStore.get("bewerbe");
      const competitionHeader = headerOf(competitionValues);
      const competitionIdIndex = headerIndex(competitionHeader, "id");
      const competitionNameIndex = headerIndex(competitionHeader, "bezeichnung");
      for (const row of competitionValues.slice(1)) {
        const id = String(row[competitionIdIndex] || "").trim();
        if (id) competitions.set(id, String(row[competitionNameIndex] || "").trim() || `Bewerb ${id}`);
      }

      const dayKeys = new Set();
      for (let timestamp = fromMs; timestamp < toMs; timestamp += 6 * 60 * 60 * 1000) dayKeys.add(viennaDay(timestamp));
      dayKeys.add(viennaDay(Math.max(fromMs, toMs - 1)));
      const days = new Map([...dayKeys].sort().map((day) => [day, { total: 0, results: 0, challenges: 0, dateChanges: 0 }]));
      const roleTotals = new Map(["Spieler", "Administratoren", "Andere/Unbekannt"].map((recipientClass) => [recipientClass, { messageCount: 0, recipients: new Set() }]));
      const recipients = new Map();

      const messages = projections.map((projection) => {
        const current = people.get(projection.recipientId) || { role: "unknown", recipientClass: "Andere/Unbekannt", name: "" };
        const category = reportCategory(projection.projectionType);
        const day = days.get(viennaDay(projection.createdAt));
        day.total++;
        if (category.result) day.results++;
        if (category.challenge) day.challenges++;
        if (category.dateChange) day.dateChanges++;
        const roleTotal = roleTotals.get(current.recipientClass);
        roleTotal.messageCount++;
        roleTotal.recipients.add(projection.recipientId);
        const recipientKey = `${deployment}:${projection.recipientId}`;
        const recipient = recipients.get(recipientKey) || {
          recipientKey,
          recipientId: projection.recipientId,
          recipientName: projection.recipientName || current.name || projection.recipientId,
          recipientRole: current.role,
          recipientClass: current.recipientClass,
          messageCount: 0,
          unreadCount: 0,
          latestAt: projection.createdAt,
        };
        recipient.messageCount++;
        if (projection.acknowledgedAt === null) recipient.unreadCount++;
        recipient.latestAt = Math.max(recipient.latestAt, projection.createdAt);
        recipients.set(recipientKey, recipient);
        return {
          time: projection.createdAt,
          deployment,
          ...projection,
          recipientName: projection.recipientName || current.name || projection.recipientId,
          recipientRole: current.role,
          recipientClass: current.recipientClass,
          competitionName: projection.competitionId ? competitions.get(projection.competitionId) || `Bewerb ${projection.competitionId}` : "Allgemeine Meldung",
          isResult: category.result,
          isChallenge: category.challenge,
          isDateChange: category.dateChange,
          deliveries: JSON.stringify(projection.deliveries),
        };
      });

      const series = [...days].map(([day, counts]) => ({ time: Date.parse(`${day}T12:00:00Z`), ...counts }));
      const roleSummary = [...roleTotals].map(([recipientClass, value]) => ({ recipientClass, messageCount: value.messageCount, recipientCount: value.recipients.size }));
      this.log("info", "messaging_report_completed", { deployment, result: "success", durationMs: this.now() - startedAt, dayCount: days.size, messageCount: messages.length, recipientCount: recipients.size });
      return {
        success: true,
        deployment,
        from: fromMs,
        to: toMs,
        generatedAt: this.now(),
        totals: { messageCount: messages.length, recipientCount: recipients.size },
        series,
        roleSummary,
        recipients: [...recipients.values()].sort((left, right) => right.messageCount - left.messageCount || left.recipientName.localeCompare(right.recipientName)),
        messages,
      };
    } catch (error) {
      this.log("warn", "messaging_report_completed", { deployment, result: "failed", durationMs: this.now() - startedAt, errorCode: error.code || "MESSAGING_REPORT_FAILED" });
      throw error;
    }
  }

  summary(principal) { return { success: true, ...this.repository.summary(principal.id) }; }

  competitionName(competitionId) {
    if (!competitionId) return "Allgemeine Meldung";
    const values = dataStore.get("bewerbe");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const nameIndex = headerIndex(header, "bezeichnung");
    const competition = values.slice(1).find((row) => String(row[idIndex] || "").trim() === competitionId);
    return competition ? String(competition[nameIndex] || "").trim() || `Bewerb ${competitionId}` : `Bewerb ${competitionId}`;
  }

  matchRoundNames() {
    const values = dataStore.get("matches1");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const roundIndex = headerIndex(header, "bewerbrunde");
    if (idIndex < 0 || roundIndex < 0) return new Map();
    return new Map(values.slice(1).flatMap((row) => {
      const matchId = String(row[idIndex] || "").trim();
      const roundName = competitionRoundName(row[roundIndex]);
      return matchId && roundName ? [[matchId, roundName]] : [];
    }));
  }

  rankingCompetitionIds() {
    const values = dataStore.get("bewerbe");
    const header = headerOf(values);
    const idIndex = headerIndex(header, "id");
    const typeIndex = headerIndex(header, "bewerbsartid");
    if (idIndex < 0 || typeIndex < 0) return new Set();
    return new Set(values.slice(1).flatMap((row) => (
      String(row[typeIndex] || "").trim() === "2" ? [String(row[idIndex] || "").trim()] : []
    )).filter(Boolean));
  }

  messages(principal, params) {
    const page = this.repository.listForRecipient(principal.id, params);
    const rounds = this.matchRoundNames();
    const rankingCompetitionIds = this.rankingCompetitionIds();
    return {
      success: true,
      ...this.repository.summary(principal.id),
      nextCursor: page.nextCursor,
      messages: page.messages.map(({ id, competitionId, createdAt, subject, acknowledgedAt, source, sourceId, actorName }) => ({
        id,
        createdAt,
        competitionName: this.competitionName(competitionId),
        roundName: source === "match" && !rankingCompetitionIds.has(competitionId) ? rounds.get(sourceId) || "" : "",
        subject,
        actorName,
        acknowledgedAt,
      })),
    };
  }

  message(principal, messageId) {
    const message = this.repository.getForRecipient(principal.id, messageId);
    if (!message) throw new AppError("MESSAGE_NOT_FOUND", "Nachricht wurde nicht gefunden", 404);
    return { success: true, message: { ...message, competitionName: this.competitionName(message.competitionId) } };
  }

  acknowledge(principal, { operationId, messageId }) {
    const result = this.repository.acknowledge(principal.id, operationId, messageId);
    if (result.changed) this.publishSummary(principal.id);
    return { success: true, messageId, acknowledgedAt: result.acknowledgedAt, repeated: result.repeated, changed: result.changed };
  }

  publishSummary(recipientId) {
    try {
      const { revision, unreadCount } = this.repository.summary(recipientId);
      this.publish(`messages:${recipientId}`, { revision, unreadCount });
    } catch (error) {
      this.log("warn", "message_summary_publish_failed", { recipientId, errorCode: error.code || "PUBLISH_FAILED" });
    }
  }
}

module.exports = { MessagingService, competitionRoundName, notificationChannels };
