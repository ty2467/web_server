```ts 
  const rawData = data['orchestratedData'];
  
  if (rawData && rawData.categorizedPool) {
    // 2. Run the heavy orchestrator immediately
    this.orchestrate(rawData.categorizedPool);
  
    // 3. IPC-style signal: Tell the browser the complexity is done, paint now.
    this.cdr.detectChanges();
  } 
  
  
  //
/* FETCHES IN THE DATA; no cumbersome append */
fetchPageData(category?: string) {
  if (this.rotationInterval) clearInterval(this.rotationInterval);

  const endpoint = category ? `/api/category/${category}` : '/api/home-page';

  this.http.get<PageData>(endpoint).subscribe({ //pagedata receiver
    next: (data) => {
      if (!data || !data.categorizedPool) return;
      this.orchestrate(data.categorizedPool);
    },
    error: (err) => console.error('Data fetch failed', err)
  });
}



  private orchestrate(poolMap: { [key: string]: Article[] }) {
    this.layout = { rotisserie: null, majorFronts: [], halfFronts: [], gridColumns: [] };
  
    // 1. FLATTEN: Preserve SQL Sort (is_featured DESC, date_time DESC)
    let globalPool = Object.values(poolMap).flat();
    globalPool = Array.from(new Map(globalPool.map(a => [a.id, a])).values());
  
    // 2. TIER 0: ROTISSERIE (4+3+3) - The Mega Hook
    const leads = globalPool.filter(a => a.is_featured === 1).slice(0, 4);
    let pool = globalPool.filter(a => !leads.find(l => l.id === a.id));
  
    if (leads.length >= 4 && pool.length >= 6) {
      this.layout.rotisserie = {
        leads: leads,
        sides: pool.splice(0, 3),
        sections: pool.splice(0, 3)
      };
      this.rotisseriePool = this.layout.rotisserie.leads;
      this.startLeadRotation();
    }
  
  
    // 3. TIER 1: MAJOR FRONTS (1+3+3) - The "Big Frames"
    // We take the top of the overflow to maintain chronological/featured priority
    while (pool.length >= 7 && this.layout.majorFronts.length < 3) {
      const b = pool.splice(0, 7);
      this.layout.majorFronts.push({
        main: b[0], sides: b.slice(1, 4), sections: b.slice(4, 7)
      });
    }
  
    // 4. TIER 2: HALF FRONTS (1+3) - The Taper
    while (pool.length >= 4 && this.layout.halfFronts.length < 2) {
      const b = pool.splice(0, 4);
      this.layout.halfFronts.push({ main: b[0], sides: b.slice(1, 4) });
    }
  
    // 5. TIER 3: CATEGORY MATRIX (The Columns)
    // Everything else forms the horizontal rows of 3 columns (max 4 deep)
    const remainingByCat = pool.reduce((acc, art) => {
      if (!acc[art.category]) acc[art.category] = [];
      acc[art.category].push(art);
      return acc;
    }, {} as { [key: string]: Article[] });
  
    Object.entries(remainingByCat).forEach(([cat, articles]) => {
      if (articles.length >= 1) { // Take even small groups for the matrix
        this.layout.gridColumns.push({
          category: cat,
          articles: articles.slice(0, 4) // Max 4 vertically
        });
      }
    });
  }
  
  /**
   * HELPER FOR HTML: Splits columns into rows of 3
   */
  get matrixRows() {
    const rows = [];
    for (let i = 0; i < this.layout.gridColumns.length; i += 3) {
      rows.push(this.layout.gridColumns.slice(i, i + 3));
    }
    return rows;
  }
  
  
  // 1. Getter now points to the orchestrated pool
  get topLeadArticle(): Article | undefined {
    return this.rotisseriePool[this.currentLeadIndex];
  }



  /**for orchestration*/
  export interface OrchestratedLayout {
    rotisserie: {
      leads: Article[];    // Length 4 (The rotation pool)
      sides: Article[];    // Length 3
      sections: Article[]; // Length 3
    } | null;
    majorFronts: { main: Article, sides: Article[], sections: Article[] }[]; // 1+3+3
    halfFronts: { main: Article, sides: Article[] }[]; // 1+3
    gridColumns: { category: string, articles: Article[] }[]; // 4 deep
  }

```
