document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("pw").value;
  const err = document.getElementById("err");
  err.hidden = true;
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password: pw }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    err.textContent = j.error || res.statusText;
    err.hidden = false;
    return;
  }
  window.location.href = "/index.html";
});
