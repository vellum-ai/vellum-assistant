export function VideoIntro() {
  return (
    <div className="section_video-intro">
      <div className="padding-global new z-index-2">
        <div className="container-new new">
          <div className="video_sec-header">
            <h2 className="heading-2-new playfair">
              Agents for everything. <br />
              <em className="text-glitch">Except self control.</em>
            </h2>
            <div className="hide w-embed">
              <style dangerouslySetInnerHTML={{__html: `
.w-lightbox-frame,
.w-lightbox-embed {
  width: 80vw;
  height: 70vh;
}

.text-glitch {
  position: relative;
  display: inline-block;
  animation:
    glitch-color 1.8s linear infinite,
    glitch-jitter 1.2s steps(1) infinite;
}

@keyframes glitch-color {
  0% { text-shadow: 4px 0 0 rgb(255, 0, 0), -4px 0 0 rgb(0, 255, 255); }
  20% { text-shadow: -4px 0 0 rgb(255, 0, 0), 4px 0 0 rgb(0, 255, 255); }
  40% { text-shadow: 2px 0 0 rgb(255, 0, 0), -2px 0 0 rgb(0, 255, 255); }
  60% { text-shadow: -2px 0 0 rgb(255, 0, 0), 2px 0 0 rgb(0, 255, 255); }
  100% { text-shadow: 4px 0 0 rgb(255, 0, 0), -4px 0 0 rgb(0, 255, 255); }
}

@keyframes glitch-jitter {
  0%   { transform: translate(0); }
  10%  { transform: translate(-2px, 2px); }
  20%  { transform: translate(2px, -2px); }
  30%  { transform: translate(-1px, 1px); }
  40%  { transform: translate(1px, -1px); }
  50%  { transform: translate(-2px, 0); }
  60%  { transform: translate(2px, 0); }
  70%  { transform: translate(0, 2px); }
  80%  { transform: translate(0, -2px); }
  90%  { transform: translate(1px, 1px); }
  100% { transform: translate(0); }
}
`}} />
            </div>
            <div className="play_btn-wrap">
              <a href="#" className="play_btn w-inline-block w-lightbox">
                <div className="w-embed">
                  <svg xmlns="http://www.w3.org/2000/svg" width="2rem" height="2rem" fill="#fafafa" viewBox="0 0 256 256">
                    <path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"></path>
                  </svg>
                </div>
                <script type="application/json" className="w-json" dangerouslySetInnerHTML={{__html: JSON.stringify({
                  items: [{
                    url: "https://youtube.com/watch?v=72TU43fauo4?autoplay=1",
                    originalUrl: "https://youtube.com/watch?v=72TU43fauo4?autoplay=1",
                    width: 940,
                    height: 528,
                    thumbnailUrl: "https://i.ytimg.com/vi/72TU43fauo4/hqdefault.jpg",
                    html: "<iframe class=\"embedly-embed\" src=\"//cdn.embedly.com/widgets/media.html?src=https%3A%2F%2Fwww.youtube.com%2Fembed%2F72TU43fauo4%3Fautoplay%3D1%26feature%3Doembed&display_name=YouTube&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D72TU43fauo4&image=https%3A%2F%2Fi.ytimg.com%2Fvi%2F72TU43fauo4%2Fhqdefault.jpg&autoplay=1&type=text%2Fhtml&schema=youtube\" width=\"940\" height=\"528\" scrolling=\"no\" title=\"YouTube embed\" frameborder=\"0\" allow=\"autoplay; fullscreen; encrypted-media; picture-in-picture;\" allowfullscreen=\"true\"></iframe>",
                    type: "video"
                  }],
                  group: ""
                })}} />
              </a>
            </div>
            <div className="note_vid">
              <div className="icon_watch w-embed">
                <svg xmlns="http://www.w3.org/2000/svg" width="1rem" height="1rem" fill="#e5e7eb" viewBox="0 0 256 256">
                  <path d="M120,136V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0ZM232,91.55v72.9a15.86,15.86,0,0,1-4.69,11.31l-51.55,51.55A15.86,15.86,0,0,1,164.45,232H91.55a15.86,15.86,0,0,1-11.31-4.69L28.69,175.76A15.86,15.86,0,0,1,24,164.45V91.55a15.86,15.86,0,0,1,4.69-11.31L80.24,28.69A15.86,15.86,0,0,1,91.55,24h72.9a15.86,15.86,0,0,1,11.31,4.69l51.55,51.55A15.86,15.86,0,0,1,232,91.55Zm-16,0L164.45,40H91.55L40,91.55v72.9L91.55,216h72.9L216,164.45ZM128,160a12,12,0,1,0,12,12A12,12,0,0,0,128,160Z"></path>
                </svg>
              </div>
              <div>Watch at your own risk</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
