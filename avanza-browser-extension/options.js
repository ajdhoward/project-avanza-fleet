"use strict";

document.addEventListener("DOMContentLoaded", async () => {
	const s = await chrome.storage.sync.get(["orchUrl", "appToken", "dashboardUrl"]);
	document.getElementById("orchUrl").value = s.orchUrl || "";
	document.getElementById("appToken").value = s.appToken || "";
	document.getElementById("dashboardUrl").value = s.dashboardUrl || "";

	document.getElementById("save").addEventListener("click", async () => {
		await chrome.storage.sync.set({
			orchUrl: document.getElementById("orchUrl").value.trim().replace(/\/$/, ""),
			appToken: document.getElementById("appToken").value.trim(),
			dashboardUrl: document.getElementById("dashboardUrl").value.trim(),
		});
		const saved = document.getElementById("saved");
		saved.style.display = "block";
		setTimeout(() => (saved.style.display = "none"), 2000);
	});
});
