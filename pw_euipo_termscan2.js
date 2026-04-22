async (page) => {
  const terms = ['case','suitcase','trolley','wheel','wheels','rolling','folding','foldable','cart','container','storage'];
  const out=[];
  for(const term of terms){
    await page.locator('#basicSearchSmallInput').fill(term);
    await page.locator('#basicSearchSmallButton').click();
    await page.waitForTimeout(3000);
    const counts = await page.evaluate(()=>{
      const pick=(name)=>[...document.querySelectorAll('a')].find(a=>(a.textContent||'').includes(name+' ('));
      const c=(el)=>{if(!el)return null; const m=(el.textContent||'').match(/\((\d+)\)/); return m?Number(m[1]):null;};
      return {tm:c(pick('Trade marks')),des:c(pick('Designs')),own:c(pick('Owners')),rep:c(pick('Representatives')),url:location.href};
    });
    out.push({term,...counts});
  }
  return out;
}
