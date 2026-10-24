// Book search via Open Library: free, no key. Fails soft - manual entry always works.

let typing = null;

// replace: true cancels the previous search-as-you-type request; background lookups pass false.
export async function searchBooks(query, { replace = true } = {}) {
  const controller = new AbortController();
  if (replace) { typing?.abort(); typing = controller; }
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://openlibrary.org/search.json?limit=10&fields=key,title,author_name,cover_i,number_of_pages_median&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`openlibrary-${r.status}`);
    const data = await r.json();
    return (data.docs || []).filter((d) => typeof d.title === 'string').map((d) => ({
      title: d.title.slice(0, 500),
      author: Array.isArray(d.author_name) ? String(d.author_name[0] || '').slice(0, 500) : '',
      olKey: typeof d.key === 'string' ? d.key.slice(0, 100) : '',
      coverUrl: Number.isInteger(d.cover_i) ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
      totalPages: Number.isInteger(d.number_of_pages_median) ? d.number_of_pages_median : 0,
    }));
  } finally {
    clearTimeout(timer);
  }
}
