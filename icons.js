/* Biểu tượng Material Symbols (font con fonts/symbols-subset.woff2, gọi bằng mã điểm).
   Dùng: <md-icon data-i="more_vert"></md-icon> hoặc <span class="ms" data-i="..."></span>, rồi gọi paintIcons(root). */
(function () {
  var IC = {
  more_vert: 58836,
  folder: 58055,
  folder_open: 58056,
  language: 59540,
  help: 59527,
  info: 59534,
  videocam: 57419,
  photo_camera: 58288,
  document_scanner: 58874,
  qr_code_scanner: 61958,
  flip: 58344,
  grid_on: 58348,
  grid_off: 58347,
  timer: 58405,
  cameraswitch: 61419,
  mic: 57385,
  mic_off: 57387,
  photo_library: 58387,
  stop: 57415,
  filter_vintage: 58339,
  add: 57669,
  delete: 59506,
  check: 58826,
  close: 57676,
  content_copy: 57677,
  open_in_new: 59541,
  arrow_back: 58820,
  arrow_forward: 58824,
  check_circle: 59500,
  create_new_folder: 58060,
  play_arrow: 57399,
  offline_bolt: 59698,
  lock: 59533,
  rocket_launch: 60315,
  translate: 59618,
  code: 59503,
  verified: 57393,
  terminal: 60302,
  warning: 57346,
  videocam_off: 57420,
  speed: 59876,
  gif_box: 59299,
  error: 57344,
  download: 57713,
  radio_button_checked: 59447,
  tune: 58409,
  auto_awesome: 58975,
  history_toggle_off: 61821
  };
  window.paintIcons = function (root) {
    (root || document).querySelectorAll('[data-i]').forEach(function (el) {
      if (IC[el.dataset.i]) el.textContent = String.fromCodePoint(IC[el.dataset.i]);
    });
  };
  window.addEventListener('DOMContentLoaded', function () { window.paintIcons(); });
})();
