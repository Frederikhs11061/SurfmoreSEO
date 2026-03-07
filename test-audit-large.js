const url = "http://localhost:3001/api/audit";

// Generate 100 urls
const urls = [];
for (let i = 0; i < 100; i++) {
  urls.push(`https://surfmore.dk/?page=${i}`);
}

const data = {
  urlBatch: urls,
  origin: "https://surfmore.dk",
  forceRefresh: true
};

console.log("Starting fetch with 100 URLs...");
const start = Date.now();
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data)
})
.then(res => {
  console.log(`Response status: ${res.status} in ${Date.now() - start}ms`);
  return res.json();
})
.then(data => console.log("Success:", data.pagesAudited))
.catch(err => console.error("Error:", err));
