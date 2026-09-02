const crypto = require("crypto");
const dataStore = require("./dataStore.js");
const logger = require("./logger.js");
const { AppError } = require("./errors.js");
const { headerIndex, headerOf } = require("./tableUtils.js");

const warnedInvalidNotifications = new Set();

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

  participant({ identity, userId, role, displayName = "", type, subject, body }) {
    const external = this.person(userId).channels;
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
