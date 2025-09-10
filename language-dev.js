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
    console.error("❌ Invalid language. Use 'vi'/'vietnamese' or 'en'/'english'.");
    return;
  }
  localStorage.setItem('preferredLang', url);
  console.log(`✅ Ngôn ngữ đã đổi sang: ${url}. Thoát ra mở lại để áp dụng.`);
  console.log(`✅ Language changed to: ${url}. Exit and reopen to apply.`);
};

window.resetLanguage = function() {
  localStorage.removeItem('preferredLang');
  console.log("🗑 Ngôn ngữ đã được reset. Thoát ra mở lại để chọn lại.");
  console.log("🗑 Language has been reset. Exit and reopen to select again.");
};
