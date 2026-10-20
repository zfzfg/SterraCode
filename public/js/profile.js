import { t, getLocale, getFormatLocale } from "./i18n.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";
import { openSession, loadSessions } from "./sessions.js";
import { randomUUID } from "./uuid.js";
import { flush } from "./editor.js";

const kinds = () => ({
  test_run: t("features:profile.testEvidence"),
  tutor: t("features:profile.tutorEvidence"),
  self_assessment: t("features:profile.selfEvidence"),
  assisted: t("features:profile.assistedEvidence"),
  legacy: t("features:profile.legacyEvidence"),
});
const statuses = () => ({
  unpracticed: t("features:profile.unpracticed"),
  practicing: t("features:profile.practicing"),
  recently_demonstrated: t("features:profile.demonstrated"),
});
const outcomes = () => ({
  passed: t("features:profile.passed"),
  failed: t("features:profile.failed"),
  unsure: t("features:profile.unsure"),
  confident: t("features:profile.confident"),
  unavailable: t("features:profile.unavailable"),
});
const help = () => ({
  independent: t("features:profile.independent"),
  assisted: t("features:profile.assisted"),
  not_recorded: t("features:profile.notRecorded"),
});
let loading = 0;
export async function openProfile() {
  const sequence = ++loading,
    dialog = document.getElementById("profile-dialog");
  if (!dialog.open) dialog.showModal();
  const content = node("div", "profile-content"),
    title = node("h2", "", t("features:profile.title"));
  title.id = "profile-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = node("button", "", t("features:shared.close"));
  close.onclick = () => dialog.close();
  const header = node("div", "dialog-heading");
  header.append(title, close);
  const status = node("p", "", t("features:profile.loading"));
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
      ? t("features:profile.help")
      : t("features:profile.disabled");
    action(
      p.enabled ? t("features:profile.disable") : t("features:profile.enable"),
      async () => {
        state.settings = await api("/api/chat/settings", {
          method: "PATCH",
          body: { crossChatProfileEnabled: !p.enabled },
        });
        await openProfile();
      },
    );
    action(t("features:profile.export"), async () => {
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
    const reset = check(t("features:profile.confirmReset"));
    action(t("features:profile.reset"), async () => {
      if (!reset.checked) throw new Error(t("features:profile.checkReset"));
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
    const goal = field(t("features:profile.goal"), p.goal);
    goal.maxLength = 500;
    const zone = field(t("features:profile.timeZone"), p.timeZone),
      intervals = field(
        t("features:profile.intervals"),
        p.intervals.join(", "),
      );
    const save = node("button", "", t("features:profile.save"));
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
    const history = check(t("features:profile.confirmHistory"));
    action(t("features:profile.importHistory"), async () => {
      if (!history.checked) throw new Error(t("features:profile.checkHistory"));
      await post("/api/profile/import-history", { confirm: true });
      await openProfile();
    });
    content.append(node("h3", "", t("features:profile.reviews")));
    if (!p.reviews.length)
      content.append(node("p", "muted", t("features:profile.noReviews")));
    for (const r of p.reviews) {
      const card = node("section", "profile-card");
      card.append(
        node("h4", "", r.title),
        node(
          "p",
          "",
          t("features:profile.dueSince", {
            p1: r.reason,
            p2: r.dueDay,
            p3: p.timeZone,
          }),
        ),
      );
      action(
        t("features:profile.startReview"),
        async () => {
          if (state.busy) throw new Error(t("features:profile.finishResponse"));
          await flush();
          const s = await post(`/api/profile/reviews/${r.reviewId}/start`, {
            tutorLocale: getLocale(),
          });
          await loadSessions();
          dialog.close();
          await openSession(s.id);
        },
        card,
      ).disabled = !r.exercise;
      if (!r.exercise)
        card.append(node("p", "", t("features:profile.noExercise")));
      for (const [label, value] of [
        [t("features:profile.skip"), "skip"],
        [t("features:profile.snooze"), "snooze"],
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
    content.append(node("h3", "", t("features:profile.concepts")));
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
            `${statuses()[c.status]}${c.lastReviewedAt ? t("features:profile.lastPractice", { p1: new Date(c.lastReviewedAt).toLocaleString(getFormatLocale(), { timeZone: p.timeZone }) }) : ""}`,
          ),
          node(
            "p",
            "muted",
            t("features:profile.prerequisites", {
              p1: c.group,
              p2: c.prerequisites.join(", ") || t("features:shared.none"),
            }),
          ),
        );
        if (c.nextReviewAt)
          card.append(
            node(
              "p",
              "",
              t("features:profile.nextReview", {
                p1: c.reviewStage + 1,
                p2: c.nextReviewAt,
              }),
            ),
          );
        if (c.suggestedExercise)
          card.append(
            node(
              "p",
              "",
              t("features:profile.nextExercise", { p1: c.suggestedExercise }),
            ),
          );
        const historical = p.legacyConcepts.filter((v) => v.conceptId === c.id);
        if (historical.length)
          card.append(
            node(
              "p",
              "",
              t("features:profile.historicalConcept", {
                p1: historical.map((v) => v.label).join(", "),
              }),
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
              t("features:profile.analogy", {
                p1: analogies.map((v) => v.id).join(", "),
              }),
            ),
          );
        const evidence = node("details");
        evidence.append(
          node(
            "summary",
            "",
            t("features:profile.evidenceCount", { p1: c.evidence.length }),
          ),
        );
        for (const id of c.evidence.slice(-20).reverse()) {
          const e = p.events.find((e) => e.eventId === id);
          evidence.append(
            node(
              "p",
              "",
              t("features:profile.evidenceDetails", {
                p1: kinds()[e.evidence.kind],
                p2: outcomes()[e.evidence.outcome],
                p3:
                  e.evidence.kind === "legacy"
                    ? t("features:profile.undatedHistory")
                    : e.occurredAt,
                p4: e.taskId || "–",
                p5: e.taskVersion || "–",
                p6: e.evidence.testRunId || e.eventId,
                p7: help()[e.evidence.assistance],
              }),
            ),
          );
        }
        card.append(evidence);
        if (c.evidence.length > 20)
          evidence.append(
            node("p", "muted", t("features:profile.recentEvidence")),
          );
        for (const [label, outcome] of [
          [t("features:profile.notMastered"), "unsure"],
          [t("features:profile.feelConfident"), "confident"],
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
    timeline.append(node("summary", "", t("features:profile.timeline")));
    for (const e of p.events.slice(-50).reverse())
      timeline.append(
        node(
          "p",
          "",
          t("features:profile.timelineDetails", {
            p1: kinds()[e.evidence.kind],
            p2: outcomes()[e.evidence.outcome],
            p3: e.language,
            p4:
              e.evidence.kind === "legacy"
                ? t("features:profile.historical")
                : e.occurredAt,
            p5: e.taskId || "–",
            p6: e.conceptIds.join(", ") || t("features:profile.noConcept"),
            p7: e.legacyConceptLabels?.length
              ? t("features:profile.legacyLabels", {
                  p1: e.legacyConceptLabels.join(", "),
                })
              : "",
          }),
        ),
      );
    content.append(timeline);
    const legacy = node("details");
    legacy.append(
      node("summary", "", t("features:profile.history")),
      node("pre", "", JSON.stringify(p.legacy, null, 2)),
    );
    content.append(legacy);
    const privacy = node("details");
    privacy.append(
      node("summary", "", t("features:profile.privacy")),
      node("pre", "", p.tutorContext),
    );
    content.append(privacy);
  } catch (e) {
    status.textContent = e.message;
    status.setAttribute("role", "alert");
    if (e.code === "PROFILE_CORRUPT") {
      const confirmed = check(t("features:profile.confirmCorrupt"));
      action(t("features:profile.resetCorrupt"), async () => {
        if (!confirmed.checked)
          throw new Error(t("features:profile.checkReset"));
        await api("/api/profile", {
          method: "DELETE",
          body: { confirm: true },
        });
        await openProfile();
      });
    }
  }
}
