import { api } from "./api.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";
import { openSession, loadSessions } from "./sessions.js";
import { randomUUID } from "./uuid.js";
import { flush } from "./editor.js";

const kinds = {
  test_run: "Testbeobachtung",
  tutor: "Tutorbeurteilung",
  self_assessment: "Selbsteinschätzung",
  assisted: "Aufgabe mit Lösungshilfe",
  legacy: "Übernommener Altbestand",
};
const statuses = {
  unpracticed: "Noch nicht geübt / wenig Belege",
  practicing: "In Übung",
  recently_demonstrated: "Zuletzt selbstständig testgeprüft (eigene Angabe)",
};
const outcomes = {
  passed: "bestanden",
  failed: "fehlgeschlagen",
  unsure: "noch unsicher",
  confident: "fühle mich sicher",
  unavailable: "technisch nicht auswertbar",
};
const help = {
  independent: "selbstständig (eigene Angabe)",
  assisted: "mit Lösungshilfe",
  not_recorded: "nicht erfasst",
};
let loading = 0;
export async function openProfile() {
  const sequence = ++loading,
    dialog = document.getElementById("profile-dialog");
  if (!dialog.open) dialog.showModal();
  const content = node("div", "profile-content"),
    title = node("h2", "", "Dein Lernprofil");
  title.id = "profile-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = node("button", "", "Schließen");
  close.onclick = () => dialog.close();
  const header = node("div", "dialog-heading");
  header.append(title, close);
  const status = node("p", "", "Lernprofil wird geladen …");
  status.setAttribute("role", "status");
  dialog.replaceChildren(header, status, content);
  const action = (label, fn, parent = content) => {
    const b = node("button", "", label);
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        toast(e.message, "error");
      } finally {
        b.disabled = false;
      }
    };
    parent.append(b);
    return b;
  };
  const post = (url, body) => api(url, { method: "POST", body });
  const check = (label) => {
    const l = node("label", "checkbox-label", label),
      i = node("input");
    i.type = "checkbox";
    l.prepend(i);
    content.append(l);
    return i;
  };
  try {
    const p = await api("/api/profile");
    if (sequence !== loading || !dialog.open) return;
    status.textContent = p.enabled
      ? "Freiwilliges Lernprofil. Wenige Belege sind keine Kompetenzmessung. Lernpausen senken keine Stufe."
      : "Das sessionübergreifende Lernprofil ist deaktiviert. Aufgaben und Tests funktionieren weiterhin.";
    action(
      p.enabled ? "Profil deaktivieren" : "Profil aktivieren",
      async () => {
        state.settings = await api("/api/chat/settings", {
          method: "PATCH",
          body: { crossChatProfileEnabled: !p.enabled },
        });
        await openProfile();
      },
    );
    action("Profil exportieren", async () => {
      const data = await api("/api/profile/export"),
        link = node("a"),
        url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          }),
        );
      link.href = url;
      link.download = "sterracode-lernprofil.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const reset = check("Profil und Wiederholungsdaten bewusst löschen");
    action("Profil zurücksetzen", async () => {
      if (!reset.checked)
        throw new Error("Bitte die Löschbestätigung markieren.");
      await api("/api/profile", { method: "DELETE", body: { confirm: true } });
      await openProfile();
    });
    if (!p.enabled) return;
    const form = node("form", "profile-settings");
    const field = (label, value) => {
      const l = node("label", "field", label),
        i = node("input");
      i.value = value;
      l.append(i);
      form.append(l);
      return i;
    };
    const goal = field("Mein persönliches Lernziel", p.goal);
    goal.maxLength = 500;
    const zone = field("Zeitzone (z. B. Europe/Berlin)", p.timeZone),
      intervals = field(
        "Leitner-Intervalle in Tagen (fünf Werte)",
        p.intervals.join(", "),
      );
    const save = node("button", "", "Lernziel und Planung speichern");
    save.type = "submit";
    form.append(save);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/api/profile", {
          method: "PATCH",
          body: {
            goal: goal.value,
            timeZone: zone.value,
            intervals: intervals.value.split(",").map(Number),
          },
        });
        await openProfile();
      } catch (error) {
        toast(error.message, "error");
      }
    };
    content.append(form);
    const history = check(
      "Alte Sessionabschlüsse ausdrücklich als historische Angaben übernehmen",
    );
    action("Historische Angaben übernehmen", async () => {
      if (!history.checked)
        throw new Error("Bitte die historische Übernahme markieren.");
      await post("/api/profile/import-history", { confirm: true });
      await openProfile();
    });
    content.append(
      node("h3", "", "Freiwillige Wiederholungen (höchstens drei)"),
    );
    if (!p.reviews.length)
      content.append(
        node("p", "muted", "Gerade keine Wiederholung vorgeschlagen."),
      );
    for (const r of p.reviews) {
      const card = node("section", "profile-card");
      card.append(
        node("h4", "", r.title),
        node(
          "p",
          "",
          `${r.reason} Vorgesehen seit ${r.dueDay} (${p.timeZone}).`,
        ),
      );
      action(
        "Wiederholung starten",
        async () => {
          if (state.busy)
            throw new Error("Bitte die laufende Tutorantwort zuerst beenden.");
          await flush();
          const s = await post(`/api/profile/reviews/${r.reviewId}/start`, {});
          await loadSessions();
          dialog.close();
          await openSession(s.id);
        },
        card,
      ).disabled = !r.exercise;
      if (!r.exercise)
        card.append(
          node(
            "p",
            "",
            "Für diese Sprache ist noch keine geprüfte Offlineaufgabe verfügbar.",
          ),
        );
      for (const [label, value] of [
        ["Heute überspringen", "skip"],
        ["In drei Tagen erinnern", "snooze"],
      ])
        action(
          label,
          async () => {
            await post(`/api/profile/reviews/${r.reviewId}/results`, {
              action: value,
            });
            await openProfile();
          },
          card,
        );
      content.append(card);
    }
    content.append(node("h3", "", "Konzepte und Belege"));
    for (const language of [...new Set(p.concepts.map((c) => c.language))]) {
      const section = node("section");
      section.append(node("h4", "", language));
      for (const c of p.concepts.filter((c) => c.language === language)) {
        const card = node("article", "profile-card");
        card.append(
          node("h5", "", `${c.title} · ${c.id}`),
          node(
            "p",
            "",
            `${statuses[c.status]}${c.lastReviewedAt ? ` · Letzte Übung: ${new Date(c.lastReviewedAt).toLocaleString("de-DE", { timeZone: p.timeZone })}` : ""}`,
          ),
          node(
            "p",
            "muted",
            `Gruppe: ${c.group}. Voraussetzungen: ${c.prerequisites.join(", ") || "keine"}. Werden nicht automatisch als gekonnt gewertet.`,
          ),
        );
        if (c.nextReviewAt)
          card.append(
            node(
              "p",
              "",
              `Leitner-Stufe ${c.reviewStage + 1} · Nächste Wiederholung: ${c.nextReviewAt}`,
            ),
          );
        if (c.suggestedExercise)
          card.append(
            node("p", "", `Nächste passende Übung: ${c.suggestedExercise}`),
          );
        const historical = p.legacyConcepts.filter((v) => v.conceptId === c.id);
        if (historical.length)
          card.append(
            node(
              "p",
              "",
              `Historische Angaben ohne genaues Übungsdatum: ${historical.map((v) => v.label).join(", ")}. Kein Testnachweis.`,
            ),
          );
        const analogies = p.concepts.filter(
          (v) =>
            v.language !== c.language &&
            v.group === c.group &&
            v.evidence.length,
        );
        if (analogies.length)
          card.append(
            node(
              "p",
              "",
              `Mögliche Analogie: ${analogies.map((v) => v.id).join(", ")}. Das belegt nicht automatisch dieses Konzept.`,
            ),
          );
        const evidence = node("details");
        evidence.append(
          node("summary", "", `Herkunft und Verlauf (${c.evidence.length})`),
        );
        for (const id of c.evidence.slice(-20).reverse()) {
          const e = p.events.find((e) => e.eventId === id);
          evidence.append(
            node(
              "p",
              "",
              `${kinds[e.evidence.kind]} · ${outcomes[e.evidence.outcome]} · ${e.evidence.kind === "legacy" ? "Historische Angabe ohne gesichertes Übungsdatum" : e.occurredAt} · Aufgabe ${e.taskId || "–"}, Stand ${e.taskVersion || "–"} · Beleg ${e.evidence.testRunId || e.eventId} · Hilfe: ${help[e.evidence.assistance]}`,
            ),
          );
        }
        card.append(evidence);
        if (c.evidence.length > 20)
          evidence.append(
            node(
              "p",
              "muted",
              "Die neuesten 20 Belege sind sichtbar. Alle Belege stehen im Profilexport.",
            ),
          );
        for (const [label, outcome] of [
          ["Das beherrsche ich noch nicht", "unsure"],
          ["Ich fühle mich sicher", "confident"],
        ]) {
          const operationId = randomUUID();
          action(
            label,
            async () => {
              await post(`/api/profile/concepts/${c.id}/self-assessments`, {
                operationId,
                outcome,
              });
              await openProfile();
            },
            card,
          );
        }
        section.append(card);
      }
      content.append(section);
    }
    const timeline = node("details");
    timeline.append(
      node("summary", "", "Verlauf aller Lernbelege (neueste 50)"),
    );
    for (const e of p.events.slice(-50).reverse())
      timeline.append(
        node(
          "p",
          "",
          `${kinds[e.evidence.kind]} · ${outcomes[e.evidence.outcome]} · ${e.language} · ${e.evidence.kind === "legacy" ? "historische Angabe" : e.occurredAt} · Aufgabe ${e.taskId || "–"} · ${e.conceptIds.join(", ") || "keine Konzeptzuordnung"}${e.legacyConceptLabels?.length ? ` · Altbezeichnungen: ${e.legacyConceptLabels.join(", ")}` : ""}`,
        ),
      );
    content.append(timeline);
    const legacy = node("details");
    legacy.append(
      node(
        "summary",
        "",
        "Historische Angaben (keine nachträglichen Testbelege)",
      ),
      node("pre", "", JSON.stringify(p.legacy, null, 2)),
    );
    content.append(legacy);
    const privacy = node("details");
    privacy.append(
      node(
        "summary",
        "",
        "Diese Profilangaben erhält der ausgewählte KI-Anbieter bei der nächsten Tutorantwort",
      ),
      node("pre", "", p.tutorContext),
    );
    content.append(privacy);
  } catch (e) {
    status.textContent = e.message;
    status.setAttribute("role", "alert");
    if (e.code === "PROFILE_CORRUPT") {
      const confirmed = check("Beschädigtes Profil bewusst löschen");
      action("Beschädigtes Profil zurücksetzen", async () => {
        if (!confirmed.checked)
          throw new Error("Bitte die Löschbestätigung markieren.");
        await api("/api/profile", {
          method: "DELETE",
          body: { confirm: true },
        });
        await openProfile();
      });
    }
  }
}
