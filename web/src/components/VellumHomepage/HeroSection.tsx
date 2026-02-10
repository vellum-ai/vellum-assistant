/**
 * HeroSection Component
 * 
 * Hero content with waitlist button. Background is on parent wrapper.
 */

export function HeroSection() {
  return (
    <div 
      style={{ 
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        maxWidth: "800px",
      }}>
        {/* Title - smaller */}
        <h1 style={{
          color: "#ffffff",
          fontFamily: "Playfair Display, serif",
          fontStyle: "italic",
          fontWeight: 400,
          fontSize: "4.5rem",
          lineHeight: 1.2,
          margin: 0,
        }}>
          A personal assistant<br/>
          that you can trust
        </h1>

        {/* Description - wider */}
        <p style={{
          color: "rgba(255, 255, 255, 0.85)",
          fontSize: "1.125rem",
          lineHeight: 1.6,
          marginTop: "1.5rem",
          maxWidth: "700px",
        }}>
          An assistant with its own identity and context about your life. It clears your inbox, books flights, submits PRs, and stays yours forever.
        </p>

        {/* Waitlist Button */}
        <div style={{ marginTop: "2rem" }}>
          <a 
            href="/waitlist" 
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
              fontWeight: 600,
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
  );
}
