// Minimal mock of the YouTube IFrame Player API for offline E2E tests.
(function () {
  const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const DURATION = 60;
  class Player {
    constructor(el, opts) {
      const host = typeof el === 'string' ? document.getElementById(el) : el;
      const fr = document.createElement('div');
      fr.id = host.id; fr.className = 'mock-yt';
      fr.style.cssText = 'background:#223;color:#9ab;display:flex;align-items:center;justify-content:center;font:14px sans-serif';
      host.replaceWith(fr);
      this._el = fr; this._opts = opts || {}; this._ev = this._opts.events || {};
      this._videoId = this._opts.videoId; this._base = 0; this._startPerf = 0; this._playing = false; this._state = PlayerState.UNSTARTED;
      this._label();
      window.__ytPlayer = this;
      setTimeout(() => { this._ev.onReady && this._ev.onReady({ target: this }); }, 50);
      this._endTimer = setInterval(() => { if (this._playing && this.getCurrentTime() >= DURATION) { this._base = DURATION; this._playing = false; this._set(PlayerState.ENDED); } }, 100);
    }
    _label() { this._el.textContent = 'MOCK YouTube: ' + this._videoId; }
    _set(s) { this._state = s; setTimeout(() => this._ev.onStateChange && this._ev.onStateChange({ target: this, data: s }), 0); }
    getCurrentTime() { return this._playing ? Math.min(DURATION, this._base + (performance.now() - this._startPerf) / 1000) : this._base; }
    playVideo() { if (this._playing) return; this._startPerf = performance.now(); this._playing = true; this._set(PlayerState.PLAYING); }
    pauseVideo() { if (!this._playing) return; this._base = this.getCurrentTime(); this._playing = false; this._set(PlayerState.PAUSED); }
    seekTo(s) { this._base = Math.max(0, s); this._startPerf = performance.now(); }
    cueVideoById(id) { this._videoId = typeof id === 'object' ? id.videoId : id; this._base = 0; this._playing = false; this._label(); this._set(PlayerState.CUED); }
    loadVideoById(id) { this.cueVideoById(id); this.playVideo(); }
    getVideoData() { return { video_id: this._videoId, title: 'テスト曲 ' + this._videoId }; }
    getPlaybackRate() { return 1; }
    getPlayerState() { return this._state; }
    getDuration() { return DURATION; }
    destroy() { clearInterval(this._endTimer); }
  }
  window.YT = { Player, PlayerState, loaded: 1 };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
