// Plain-language workflow events for the founder. This is the one physical
// source used by both consoles; the dashboard re-serves it from /lib.

const nothingNeeded = (sentence) => `${sentence} Nothing needed from you.`;
const actionNeeded = (sentence) => `${sentence} Your decision is needed before work can continue.`;

export function untranslatedEventSentence(type) {
  return `Internal step: ${type} (no plain description yet)`;
}

const EVENT_TRANSLATIONS = {
  "task-created": {
    sentence: nothingNeeded("The task was created and is ready to move through the factory."),
    needsFounderAction: false,
  },
  "stage-pass": {
    sentence: nothingNeeded("This check passed and the work can move forward."),
    needsFounderAction: false,
  },
  "stage-fail": {
    sentence: nothingNeeded("This check found a problem and the factory is routing it for correction."),
    needsFounderAction: false,
  },
  "stage-decision-required": {
    sentence: actionNeeded("This stage stopped because it needs a founder decision."),
    needsFounderAction: true,
  },
  "stage-evidence-verified": {
    sentence: nothingNeeded("The evidence for this stage was verified against the current code."),
    needsFounderAction: false,
  },
  "stage-decision-deferred": (event) => event.escalated
    ? {
        sentence: actionNeeded("A decision recorded during this stage has been escalated for your attention."),
        needsFounderAction: true,
      }
    : {
        sentence: nothingNeeded("A non-urgent decision was recorded for later review."),
        needsFounderAction: false,
      },
  "merge-ready": {
    sentence: nothingNeeded("Every required check passed and the change is ready for the founder-controlled merge."),
    needsFounderAction: false,
  },
  "handoff-ready": {
    sentence: nothingNeeded("The current stage finished its handoff and the next stage can begin."),
    needsFounderAction: false,
  },
  "task-resumed": {
    sentence: nothingNeeded("The task resumed from its last safe point."),
    needsFounderAction: false,
  },
  "failure-routed": (event) => event.stage === "builder"
    ? {
        sentence: nothingNeeded("The work was sent back to the builder to fix the problem."),
        needsFounderAction: false,
      }
    : {
        sentence: nothingNeeded("The same check is being retried after an infrastructure problem."),
        needsFounderAction: false,
      },
  "seat-pause-escalated": {
    sentence: actionNeeded("Repeated capacity pauses stopped this stage and were escalated for your attention."),
    needsFounderAction: true,
  },
  "dispatch-paused-seats": {
    sentence: nothingNeeded("This agent run paused until execution capacity is available again."),
    needsFounderAction: false,
  },
  "recovery-incident-closed": {
    sentence: nothingNeeded("The recovery incident was closed."),
    needsFounderAction: false,
  },
  "failure-classified": {
    sentence: nothingNeeded("The factory classified the failure so it can choose the right recovery path."),
    needsFounderAction: false,
  },
  "recovery-diagnosing": {
    sentence: nothingNeeded("The recovery process is diagnosing what went wrong."),
    needsFounderAction: false,
  },
  "recovery-repair-attempted": {
    sentence: nothingNeeded("The recovery process attempted a repair."),
    needsFounderAction: false,
  },
  "recovery-verifying": {
    sentence: nothingNeeded("An independent check is verifying the recovery repair."),
    needsFounderAction: false,
  },
  "recovery-verification": {
    sentence: nothingNeeded("The recovery verification result was recorded."),
    needsFounderAction: false,
  },
  "recovery-verified": {
    sentence: nothingNeeded("The repair was verified and normal work can resume."),
    needsFounderAction: false,
  },
  "recovery-escalated": {
    sentence: actionNeeded("Automated recovery could not safely continue and stopped for your direction."),
    needsFounderAction: true,
  },
  "founder-approval-recorded": {
    sentence: nothingNeeded("Your approval was recorded and the factory can continue."),
    needsFounderAction: false,
  },
  "evidence-invalidated": {
    sentence: nothingNeeded("Earlier evidence was invalidated because the code changed and will be collected again."),
    needsFounderAction: false,
  },
  "commit-frozen": {
    sentence: "The build is finished and the code is locked so the reviewer, QA and security check the same commit. Nothing needed from you.",
    needsFounderAction: false,
  },
  "founder-approval-key-revoked": {
    sentence: nothingNeeded("A founder approval key was revoked and can no longer authorize changes."),
    needsFounderAction: false,
  },
  "objective-finished": {
    sentence: nothingNeeded("The objective reached its final recorded outcome."),
    needsFounderAction: false,
  },
  "node-blocked-by-dep": {
    sentence: nothingNeeded("This part of the objective is waiting for an earlier part to finish."),
    needsFounderAction: false,
  },
  // Every current node-blocked and integration-blocked emitter represents a
  // decision-required blocker. If that invariant changes, the event must carry
  // enough blocker context for this presentation layer to distinguish it.
  "node-blocked": {
    sentence: actionNeeded("This part of the objective stopped because it needs your direction."),
    needsFounderAction: true,
  },
  "node-gate-satisfied": {
    sentence: nothingNeeded("This part of the objective passed all of its required checks."),
    needsFounderAction: false,
  },
  "node-waiting-for-delegate": {
    sentence: nothingNeeded("This part of the objective is waiting for its assigned agent to finish."),
    needsFounderAction: false,
  },
  "node-failed": {
    sentence: nothingNeeded("This part of the objective failed and the factory recorded the outcome for routing."),
    needsFounderAction: false,
  },
  "node-started": {
    sentence: nothingNeeded("Work started on this part of the objective."),
    needsFounderAction: false,
  },
  "integration-started": {
    sentence: nothingNeeded("The completed build branches are being combined for final checks."),
    needsFounderAction: false,
  },
  "integration-conflict": {
    sentence: actionNeeded("The build branches changed the same code and cannot be combined without a choice."),
    needsFounderAction: true,
  },
  "integration-gate-satisfied": {
    sentence: nothingNeeded("The combined build passed its final integration checks."),
    needsFounderAction: false,
  },
  "integration-blocked": {
    sentence: actionNeeded("The combined build stopped because it needs your direction."),
    needsFounderAction: true,
  },
  "objective-node-retry": {
    sentence: nothingNeeded("This part of the objective was queued to try again from its last safe point."),
    needsFounderAction: false,
  },
  "node-unblocked": {
    sentence: nothingNeeded("An earlier blocker cleared and this part of the objective can continue."),
    needsFounderAction: false,
  },
  "objective-recovery-requested": {
    sentence: nothingNeeded("Recovery was requested for the affected parts of the objective."),
    needsFounderAction: false,
  },
  "objective-cancelled": {
    sentence: nothingNeeded("The objective was cancelled and no new work will start."),
    needsFounderAction: false,
  },
  "objective-yielded": {
    sentence: nothingNeeded("This factory-improvement objective paused before starting more work so founder-requested work can go first."),
    needsFounderAction: false,
  },
  "objective-resumed": {
    sentence: nothingNeeded("Founder-requested work cleared and this factory-improvement objective resumed from its last safe point."),
    needsFounderAction: false,
  },
  "node-resumed": {
    sentence: nothingNeeded("This part of the objective resumed from its last safe point."),
    needsFounderAction: false,
  },
};

export function translateEvent(event) {
  const type = event?.type;
  const translation = EVENT_TRANSLATIONS[type];
  if (!translation) {
    return { sentence: untranslatedEventSentence(type), needsFounderAction: false };
  }
  return typeof translation === "function" ? translation(event) : { ...translation };
}
