const url = "http://localhost:3001/api/audit";
const data = {
  urlBatch: ["https://surfmore.dk/", "https://surfmore.dk/collections", "https://surfmore.dk/products"],
  origin: "https://surfmore.dk",
  forceRefresh: true
};

fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data)
})
.then(res => res.json())
.then(data => console.log("Success:", data.pagesAudited))
.catch(err => console.error("Error:", err));
