import "./AudioPlayer.css";
import {formatDuration} from "/common/pure-utils.js";
import {$cleanup} from "unconscious";
import {downloadFile} from "/src/utils/utils.js";

const speeds = [1.0, 1.5, 2.0, 0.5];

/**
 * @deprecated
 * @param {string | Blob | File} src
 * @param {boolean} [autoplay]
 * @return {JSX.Element}
 * @constructor
 */
export const AudioPlayer = ({src, autoplay}) => {
	const timeUpdate = () => {
		// 自动更新时间显示
		timeDisplay.textContent = `${formatDuration(audio.currentTime)} / ${formatDuration(audio.duration)}`;
		// 计算百分比并更新进度条 (只在没有被用户拖拽时更新)
		if (audio.duration) {
			progressBar.value = (audio.currentTime / audio.duration) * 100;
		}
	};

	const audio = <audio preload="metadata"
		onLoadedMetadata={timeUpdate} onTimeUpdate={timeUpdate}
		onEnded={() => playBtn.className = "ri-play-fill"}
	/>;

	let filename = 'media';
	if (typeof src !== "string") {
		filename = src.name || 'media';
		audio.src = src.toUrl();
		$cleanup(audio, () => src.revokeUrl());
	} else {
		audio.src = src;
	}

	let playBtn, timeDisplay, progressBar, speedBtn;
	let currentSpeedIndex = 0;


	return (<div className="my-audio-player">
			{audio}
			<button ref={playBtn} className={"ri-play-fill"} onClick={({target}) => {
				if (audio.paused) {
					audio.play();
					target.className = "ri-pause-fill";
				} else {
					audio.pause();
					target.className = "ri-play-fill";
				}
			}}></button>
			<span className="time-display" ref={timeDisplay}>0:00 / --:--</span>
			<input type="range" className="progress-bar" ref={progressBar} value="0" min="0" max="100" step="0.1"
				   onInput={({target}) => {
					   const seekTime = (target.value / 100) * audio.duration;
					   if (!isNaN(seekTime)) {
						   audio.currentTime = seekTime;
					   }
				   }}/>
			<button className="speed-btn" ref={speedBtn} onClick={() => {
				currentSpeedIndex = (currentSpeedIndex + 1) % speeds.length;
				const newSpeed = speeds[currentSpeedIndex];
				audio.playbackRate = newSpeed;
				speedBtn.textContent = newSpeed.toFixed(1) + 'x';
			}}>1.0x
			</button>

			<div className="volume-container">
				<span className={"ri-volume-up-fill"}></span>
				<input type="range" className="volume-bar" value="100" min="0" max="100" onInput={({target}) => {
					audio.volume = target.value / 100;
				}}/>
			</div>

			<button className="download-btn ri-download-2-line" title="下载" onClick={() => downloadFile(src, filename)} />
		</div>
	);
};