/**
 * quiz.js
 * ---------------------------------------------------------------------------
 * "Which wonder?" — five questions drawn from the facts and highlights in
 * data/wonders.json, with the wonder's own names (quizAliases) blanked out.
 * Four choices each; after answering you can carry on or travel there.
 * ---------------------------------------------------------------------------
 */
const ROUND = 5;
const BLANK = '<span class="quiz-blank" aria-label="blank">▁▁▁</span>';

export function createQuiz(dialog, { wonders, onGo }) {
  const $ = (s) => dialog.querySelector(s);
  const el = {
    progress: $('[data-quiz-progress]'),
    question: $('[data-quiz-question]'),
    choices: $('[data-quiz-choices]'),
    result: $('[data-quiz-result]'),
    next: $('[data-quiz-next]'),
    go: $('[data-quiz-go]'),
  };
  const pool = buildPool(wonders);
  let round = [], i = 0, score = 0, answered = false;

  el.next.addEventListener('click', () => (i + 1 < round.length ? ask(i + 1) : finish()));
  el.go.addEventListener('click', () => { dialog.close(); onGo(round[i].answer); });
  $('[data-quiz-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  function start() {
    round = sample(pool, ROUND).map((q) => ({ ...q, options: optionsFor(q.answer) }));
    score = 0;
    ask(0);
    if (!dialog.open) dialog.showModal();
  }

  function ask(n) {
    i = n;
    answered = false;
    const q = round[i];
    el.progress.textContent = `Question ${i + 1} of ${round.length} · Score ${score}`;
    el.question.innerHTML = q.html;
    el.result.hidden = true;
    el.go.hidden = true;
    el.next.hidden = true;
    el.choices.innerHTML = q.options.map((w) =>
      `<button class="btn btn-ghost quiz-choice" data-choice="${w}">${escapeHTML(wonders[w].name)}</button>`).join('');
    el.choices.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.choice), b)));
    el.choices.querySelector('button')?.focus();
  }

  function answer(choice, button) {
    if (answered) return;
    answered = true;
    const q = round[i];
    const right = choice === q.answer;
    if (right) score++;
    el.choices.querySelectorAll('[data-choice]').forEach((b) => {
      const w = Number(b.dataset.choice);
      b.disabled = true;
      b.classList.toggle('is-right', w === q.answer);
      b.classList.toggle('is-wrong', b === button && !right);
    });
    el.progress.textContent = `Question ${i + 1} of ${round.length} · Score ${score}`;
    el.result.hidden = false;
    el.result.textContent = right ? `Yes — ${wonders[q.answer].name}.` : `Not quite — it's ${wonders[q.answer].name}.`;
    el.go.hidden = false;
    el.go.textContent = `Go to ${wonders[q.answer].name}`;
    el.next.hidden = false;
    el.next.textContent = i + 1 < round.length ? 'Next question' : 'See your score';
    el.next.focus();
  }

  function finish() {
    el.progress.textContent = 'Done';
    el.question.innerHTML = `<span class="quiz-score">${score} of ${round.length}</span>${verdict(score, round.length)}`;
    el.choices.innerHTML = '<button class="btn btn-primary" data-again>Play again</button>';
    el.choices.querySelector('[data-again]').addEventListener('click', start);
    el.choices.querySelector('[data-again]').focus();
    el.result.hidden = true;
    el.go.hidden = true;
    el.next.hidden = true;
  }

  function optionsFor(answer) {
    const others = sample(wonders.map((_, k) => k).filter((k) => k !== answer), 3);
    return sample([answer, ...others], 4);
  }

  return { start, get open() { return dialog.open; } };
}

/** Every fact and highlight that still makes a fair question once names are blanked. */
function buildPool(wonders) {
  const out = [];
  wonders.forEach((w, answer) => {
    const aliases = [...(w.quizAliases || [w.name])].sort((a, b) => b.length - a.length);
    const texts = [
      ...(w.facts || []).filter((f) => f.type !== 'myth').map((f) => f.text),
      ...(w.highlights || []),
    ];
    for (const text of texts) {
      let html = escapeHTML(text);
      for (const a of aliases) html = html.replace(new RegExp(escapeRe(escapeHTML(a)), 'g'), BLANK);
      // Skip anything that is mostly blanks or too short to be a fair clue.
      if (text.length < 50 || (html.match(/quiz-blank/g) || []).length > 3) continue;
      out.push({ answer, html });
    }
  });
  return out;
}

function verdict(score, total) {
  const r = score / total;
  const line = r === 1 ? 'A perfect round.' : r >= 0.6 ? 'Well travelled.' : 'Plenty left to explore — try another round.';
  return `<span class="quiz-verdict">${line}</span>`;
}

function sample(list, n) {
  const a = [...list];
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a.slice(0, n);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
