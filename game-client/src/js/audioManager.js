class AudioManager {
  constructor() {
    this.sounds = {};
    this.timerWarningActive = false;
    this.timerSource = null;
    this.timerBuffer = null;
    this.muted = false;
    this.initialized = false;
    this.audioContext = null;
    this.enabled = true;
  }

  async init() {
    if (this.initialized || !this.enabled) {
      return;
    }

    const manifest = {
      xPlace: './assets/sounds/x_place.mp3',
      oPlace: './assets/sounds/o_place.mp3',
      timerWarning: './assets/sounds/timer_warning.mp3',
      gameWon: './assets/sounds/GameWon.mp3',
      gameLost: './assets/sounds/GameLost.mp3',
    };

    console.info('[Audio] initializing');

    await Promise.all(
      Object.entries(manifest).map(([key, src]) => this.preloadAudioElement(key, src)),
    );

    if (window.AudioContext || window.webkitAudioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx();

      const resume = () => {
        if (this.audioContext.state === 'suspended') {
          this.audioContext.resume().catch(() => {});
        }
        window.removeEventListener('touchend', resume);
        window.removeEventListener('click', resume);
      };
      window.addEventListener('touchend', resume, { once: true });
      window.addEventListener('click', resume, { once: true });

      await this.loadTimerBuffer(manifest.timerWarning);
    }

    this.initialized = true;
    console.info('[Audio] initialized');
  }

  async preloadAudioElement(key, src) {
    return new Promise((resolve) => {
      const audio = new Audio(src);
      audio.preload = 'auto';
      if (key === 'timerWarning') {
        audio.loop = true;
      }
      audio.addEventListener('canplaythrough', () => {
        console.info('[Audio] loaded', key, audio.src);
        resolve();
      }, { once: true });
      audio.addEventListener('error', (e) => {
        console.warn('[Audio] load error', key, audio.src, e);
        resolve();
      }, { once: true });
      audio.load();
      this.sounds[key] = audio;
    });
  }

  async loadTimerBuffer(src) {
    if (!this.audioContext) {
      return;
    }
    try {
      const response = await fetch(src, { cache: 'force-cache' });
      const arrayBuffer = await response.arrayBuffer();
      this.timerBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    } catch (error) {
      console.warn('Failed to prepare timer buffer', error);
      this.timerBuffer = null;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) {
      this.stopTimerWarning();
    }
  }

  async ensureContextReady() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.info('[Audio] context resumed');
      } catch (error) {
        console.warn('Audio context resume failed', error);
      }
    }
  }

  play(name) {
    if (this.muted || !this.sounds[name]) {
      return;
    }

    const audio = this.sounds[name];
    const attemptPlay = async () => {
      try {
        await this.ensureContextReady();
        audio.currentTime = 0;
        console.info('[Audio] play', name, 'state=', this.audioContext?.state);
        await audio.play();
      } catch (error) {
        console.warn('[Audio] play failed', name, error?.message || error);
        // Fallback: clone node to avoid locked state
        try {
          const clone = audio.cloneNode(true);
          clone.currentTime = 0;
          await clone.play();
          console.info('[Audio] fallback clone played', name);
        } catch (err) {
          console.warn('[Audio] fallback clone failed', name, err?.message || err);
        }
      }
    };
    attemptPlay();
  }

  startTimerWarning() {
    if (this.muted || this.timerWarningActive) {
      return;
    }

    this.timerWarningActive = true;

    if (this.audioContext && this.timerBuffer) {
      this.ensureContextReady()?.catch?.(() => {});
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = this.timerBuffer;
        source.loop = true;
        source.connect(this.audioContext.destination);
        source.start(0);
        this.timerSource = source;
        return;
      } catch (error) {
        console.warn('[Audio] timer start failed', error);
      }
    }

    const warning = this.sounds.timerWarning;
    if (warning) {
      warning.currentTime = 0;
      warning.play().catch(() => {});
    }
  }

  stopTimerWarning() {
    if (this.timerSource) {
      try {
        this.timerSource.stop(0);
      } catch (error) {
        // ignore
      }
      try {
        this.timerSource.disconnect();
      } catch (error) {
        // ignore
      }
      this.timerSource = null;
    }

    const warning = this.sounds.timerWarning;
    if (warning) {
      warning.pause();
      warning.currentTime = 0;
    }

    this.timerWarningActive = false;
  }
}

const audioManager = new AudioManager();

export default audioManager;
