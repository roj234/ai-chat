import "./AudioPlayer.css";

export const AudioPlayer = ({src, autoplay}) => {
	let audio, playBtn, timeDisplay, progressBar, speedBtn;
	const speeds = [1.0, 1.5, 2.0, 0.5];
	let currentSpeedIndex = 0;

	// 工具函数：格式化时间为 mm:ss
	function formatTime(seconds) {
		if (isNaN(seconds)) return "0:00";
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${s < 10 ? '0' : ''}${s}`;
	}

	if (typeof src !== "string") src = src.toUrl();

	return (<div className="my-audio-player">
			<audio ref={audio} src={src} preload="metadata"
				   onLoadedMetadata={() => {
					   timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
				   }}
				   onTimeUpdate={() => {
					   // 自动更新时间显示
					   timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`;
					   // 计算百分比并更新进度条 (只在没有被用户拖拽时更新)
					   if (audio.duration) {
						   progressBar.value = (audio.currentTime / audio.duration) * 100;
					   }
				   }}
				   onEnded={() => {
					   playBtn.className = "ri-play-fill";
				   }}
			></audio>
			<button ref={playBtn} className={"ri-play-fill"} onClick={({target}) => {
				if (audio.paused) {
					audio.play();
					target.className = "ri-pause-fill";
				} else {
					audio.pause();
					target.className = "ri-play-fill";
				}
			}}></button>
			<span className="time-display" ref={timeDisplay}>0:00 / 0:00</span>
			<input type="range" className="progress-bar" ref={progressBar} value="0" min="0" max="100" step="0.1" onInput={({target}) => {
				const seekTime = (target.value / 100) * audio.duration;
				if (!isNaN(seekTime)) {
					audio.currentTime = seekTime;
				}
			}} />
			<button className="speed-btn" ref={speedBtn} onClick={() => {
				currentSpeedIndex = (currentSpeedIndex + 1) % speeds.length;
				const newSpeed = speeds[currentSpeedIndex];
				audio.playbackRate = newSpeed;
				speedBtn.textContent = newSpeed.toFixed(1) + 'x';
			}}>1.0x</button>

			<div className="volume-container">
				<span className={"ri-volume-up-fill"}></span>
				<input type="range" className="volume-bar" value="100" min="0" max="100" onInput={({target}) => {
					audio.volume = target.value / 100;
				}} />
			</div>

			<a href={src} className="download-btn ri-download-2-line" title={"下载"} download={"audio"}></a>
		</div>
	);
};