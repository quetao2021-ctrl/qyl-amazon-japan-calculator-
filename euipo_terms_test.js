const terms = [
  'foldable trolley',
  'trolley box',
  'wheeled storage box',
  'storage box with wheels',
  'folding cart',
  'shopping trolley',
  'luggage trolley',
  'suitcase with wheels',
  'collapsible box',
  'portable storage box'
];
const out = [];
for (const term of terms) {
  const input = document.querySelector('#basicSearchBigInput');
  const btn = document.querySelector('#basicSearchBigButton');
  if (!input || !btn) { out.push({term, error:'no input/button'}); continue; }
  input.value = term;
  input.dispatchEvent(new Event('input', {bubbles:true}));
  btn.click();
  await new Promise(r => setTimeout(r, 2200));
  const d = [...document.querySelectorAll('a')].find(a => /Designs \(/.test(a.textContent||''));
  const t = [...document.querySelectorAll('a')].find(a => /Trade marks \(/.test(a.textContent||''));
  const getCount = (el) => {
    if(!el) return null;
    const m = (el.textContent||'').match(/\((\d+)\)/);
    return m ? Number(m[1]) : null;
  };
  out.push({term, designs:getCount(d), trademarks:getCount(t), url:location.href});
}
return out;
