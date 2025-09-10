// 🔧 Cheat code dev tool cho PWA camera
// Dùng trong console để đổi/reset ngôn ngữ

window.changeLanguage = function(lang) {
  let url;
  if (lang === 'vi' || lang === 'vietnamese') {
    url = 'vietnamese.html';
  } else if (lang === 'en' || lang === 'english') {
    url = 'english.html';
  } else {
    console.error("❌ Ngôn ngữ không hợp lệ. Dùng 'vi'/'vietnamese' hoặc 'en'/'english'.");
    return;
  }
  localStorage.setItem('preferredLang', url);
  console.log(`✅ Ngôn ngữ đã đổi sang: ${url}. Reload (F5) để áp dụng.`);
};

window.resetLanguage = function() {
  localStorage.removeItem('preferredLang');
  console.log("🗑 Ngôn ngữ đã được reset. Reload (F5) để chọn lại.");
};
