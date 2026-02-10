/**
 * HeroSection Component
 * 
 * Hero with pixel art background and waitlist button.
 */

export function HeroSection() {
  return (
    <div 
      className="section_home home"
      style={{
        backgroundImage: "url('/hero-bg.jpg')",
        backgroundSize: "cover",
        backgroundPosition: "center top",
        backgroundRepeat: "no-repeat",
        position: "relative",
      }}
    >
      {/* Dark overlay for text readability */}
      <div 
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          zIndex: 1,
        }}
      />
      <div className="padding-global home z-index-2" style={{ position: "relative", zIndex: 2 }}>
        <div className="container-new alt home">
          <div className="padding-section-medium">
            <div className="content-hero home">
              <div className="home-hero-header">
                <div className="text-align-center text-wrap-balance">
                  <div className="spacer-xxsmall"></div>
                  <h1 className="heading-1-new text-color-white font-playfair">
                    <em className="italic-text-12">AI agents for your<br/></em>
                    <span><em>boring ops tasks</em></span>
                  </h1>
                </div>
              </div>

              <div className="z-index-2">
                <div className="prompt-box_main">
                  <div className="prompt-box-head">
                    <div className="prompt-box-wrap mobile-off main">
                      {/* Waitlist Button */}
                      <div style={{ 
                        display: "flex", 
                        justifyContent: "center", 
                        padding: "2rem 1.5rem",
                      }}>
                        <a 
                          href="/waitlist" 
                          className="d-button cta-get-started"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            padding: "0.875rem 1.75rem",
                            backgroundColor: "#6860ff",
                            color: "#ffffff",
                            borderRadius: "8px",
                            textDecoration: "none",
                            fontSize: "1rem",
                            fontWeight: "600",
                            transition: "background-color 0.15s ease",
                          }}
                        >
                          Get on the waitlist
                          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentColor"/>
                          </svg>
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
