const LATE_THRESHOLD_DAYS = 35;

function parseMilestones(raw) {
  return String(raw || '25,50,75,100')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b);
}

function daysBetween(from, to) {
  const ms = to.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function computeProjectView(project, transactions) {
  const totalAmount = Number(project.total_amount);
  const monthlyBudget = Number(project.monthly_budget);

  const paid = transactions
    .filter((t) => t.type === 'versement')
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const remaining = Math.max(0, Math.round((totalAmount - paid) * 100) / 100);
  const progress = totalAmount > 0 ? Math.min(100, (paid / totalAmount) * 100) : 0;

  const hasContestation = transactions.some((t) => t.type === 'contestation');
  const isFinished = remaining <= 0;

  const versements = transactions
    .filter((t) => t.type === 'versement')
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  const lastVersementAt = versements.length ? versements[0].occurred_at : project.created_at;

  const daysSinceLast = daysBetween(new Date(lastVersementAt), new Date());
  const isLate = !isFinished && !project.paused && daysSinceLast > LATE_THRESHOLD_DAYS;

  let status = 'en_cours';
  if (isFinished) status = 'termine';
  else if (hasContestation) status = 'conteste';
  else if (project.paused) status = 'pause';
  else if (isLate) status = 'a_relancer';

  const milestones = parseMilestones(project.milestones);
  const nextMilestone = milestones.find((m) => m > progress + 0.001) || null;

  return {
    id: project.id,
    name: project.name,
    note: project.note,
    totalAmount,
    monthlyBudget,
    paid: Math.round(paid * 100) / 100,
    remaining,
    progress: Math.round(progress * 10) / 10,
    started: Boolean(project.started),
    paused: Boolean(project.paused),
    archived: Boolean(project.archived),
    mamanActivated: Boolean(project.secret_code),
    contested: hasContestation,
    late: isLate,
    status,
    milestones,
    nextMilestone,
    lastVersementAt,
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

module.exports = { computeProjectView, parseMilestones, LATE_THRESHOLD_DAYS };
