async (page) => {
  const terms = ['shopping trolley','luggage trolley','foldable crate','storage box','collapsible trolley','foldable trolley'];
  const out=[];
  for (const term of terms) {
    await page.locator('#PROD_input').fill(term);
    await page.click('#design_search .searchButton');
    await page.waitForTimeout(3500);
    const item = await page.evaluate(() => {
      const summary = [...document.querySelectorAll('div,span,p')].map(n=> (n.textContent||'').trim()).find(t => /\d+\s*-\s*\d+\s*\/\s*\d[\d,]*/.test(t)) || '';
      const rows = [...document.querySelectorAll('[role="row"]')].filter(r => /DM\/\d+/.test(r.textContent||''));
      const picks = rows.slice(0,5).map(r => {
        const text=(r.textContent||'').replace(/\s+/g,' ').trim();
        const dm=(text.match(/DM\/\d+/)||[])[0]||null;
        const reg=(text.match(/HAGUE\.D\d+/)||[])[0]||null;
        const date=(text.match(/20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2}/)||[])[0]||null;
        const loc=(text.match(/\b\d{2}-\d{2}(?:,\d{2}-\d{2})*/)||[])[0]||null;
        const href = r.querySelector('a[href*="getData.jsp"]')?.getAttribute('href') || null;
        const img = r.querySelector('img')?.getAttribute('src') || null;
        let product=null;
        const cells=[...r.querySelectorAll('[role="gridcell"],td')].map(c=>(c.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
        // heuristic: product usually after locarno-like token and before designations/country list
        const locIdx = cells.findIndex(c => /\b\d{2}-\d{2}(?:,\d{2}-\d{2})*/.test(c));
        if (locIdx>=0 && cells[locIdx+1]) product = cells[locIdx+1];
        return {dm, reg, date, loc, product, href, img};
      });
      return {summary, rows: rows.length, picks};
    });
    out.push({term, ...item});
  }
  return out;
}
