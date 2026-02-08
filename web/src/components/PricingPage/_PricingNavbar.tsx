import Link from "next/link";

export function PricingNavbar() {
  return (
    <div data-collapse="medium" data-animation="default" data-duration="400" fsScrolldisableElement="smart-nav" data-easing="ease" data-easing2="ease" role="banner" className="navbar_component new-light w-nav">
      <div className="navbar2_container">
        <Link href="/" id="w-node-a96c413e-e7e7-0140-ac47-2f6f46975e16-46975e14" className="navbar2_logo-link w-nav-brand">
          <img loading="lazy" src="https://cdn.prod.website-files.com/63f416b32254e8eca5d8af54/6853f41167390a6658f3fd68_Vellum%20Wordmark%20Logo.svg" alt="" className="navbar2_logo is-light" />
        </Link>
        <nav role="navigation" id="w-node-a96c413e-e7e7-0140-ac47-2f6f46975e18-46975e14" className="navbar2_menu is-page-height-tablet w-nav-menu">
          <ul fsScrolldisableElement="preserve" role="list" className="nav_list u-hflex-between-center list-new new w-list-unstyled">
            <li className="nav_list_item new hide-tablet">
              <div data-delay="200" data-hover="true" arialLabel="Hover on Products dropdown" className="nav_list_dropdown nav_new-link w-dropdown">
                <div className="dropdown_toggle u-hflex-center-center new-link w-dropdown-toggle">
                  <div>
Products
                  </div>
                  <svg width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_icon smaller">
                    <path opacity="0.4" d="M12.6875 16.7188C12.3125 17.125 11.6562 17.125 11.2812 16.7188L5.28125 10.7188C4.875 10.3438 4.875 9.6875 5.28125 9.3125C5.65625 8.90625 6.3125 8.90625 6.6875 9.3125L12 14.5938L17.2812 9.3125C17.6562 8.90625 18.3125 8.90625 18.6875 9.3125C19.0938 9.6875 19.0938 10.3438 18.6875 10.7188L12.6875 16.7188Z" fill="currentColor"></path>
                  </svg>
                </div>
                <nav className="dropdown_list dark-mode w-dropdown-list">
                  <div className="dropdown_list_inner">
                    <a aria-label="Go to Prompting page" href="/products/orchestration" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M3 6.5C3 5.6875 3.65625 5 4.5 5H7.5C8.3125 5 9 5.6875 9 6.5V9.5C9 10.3438 8.3125 11 7.5 11H4.5C3.65625 11 3 10.3438 3 9.5V6.5ZM10 14.5C10 13.6875 10.6562 13 11.5 13H14.5C15.3125 13 16 13.6875 16 14.5V17.5C16 18.3438 15.3125 19 14.5 19H11.5C10.6562 19 10 18.3438 10 17.5V14.5ZM16.5 5H19.5C20.3125 5 21 5.6875 21 6.5V9.5C21 10.3438 20.3125 11 19.5 11H16.5C15.6562 11 15 10.3438 15 9.5V6.5C15 5.6875 15.6562 5 16.5 5Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M7.5 11C8.25 11 8.90625 10.4375 8.96875 9.65625L11.5 13C10.7188 13 10.0625 13.5938 10 14.3438L7.5 11ZM9 7H15V9H9V7Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Orchestration
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Monitoring page" href="/products/workflows-sdk" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M7.21875 9.8125C6.9375 9.53125 6.90625 9.0625 7.1875 8.75C7.46875 8.4375 7.9375 8.4375 8.25 8.71875L11.25 11.4688C11.4062 11.5938 11.5 11.8125 11.5 12C11.5 12.2188 11.4062 12.4375 11.25 12.5625L8.25 15.3125C7.9375 15.5938 7.46875 15.5625 7.1875 15.2812C6.90625 14.9688 6.9375 14.5 7.21875 14.2188L9.625 12L7.21875 9.8125ZM11.75 14.5H16.25C16.6562 14.5 17 14.8438 17 15.25C17 15.6875 16.6562 16 16.25 16H11.75C11.3125 16 11 15.6875 11 15.25C11 14.8438 11.3125 14.5 11.75 14.5Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M5 7C5 5.90625 5.875 5 7 5H17C18.0938 5 19 5.90625 19 7V17C19 18.125 18.0938 19 17 19H7C5.875 19 5 18.125 5 17V7ZM7 9.125C7 9.15625 7 9.1875 7 9.1875C7 9.21875 7 9.25 7 9.25C7 9.3125 7 9.375 7 9.40625C7 9.46875 7.03125 9.53125 7.0625 9.5625C7.09375 9.65625 7.15625 9.75 7.21875 9.8125L9.625 12L7.21875 14.2188C7.15625 14.2812 7.09375 14.375 7.0625 14.4688C7.03125 14.5 7 14.5625 7 14.625C7 14.6562 7 14.7188 7 14.75C7 14.7812 7 14.8125 7 14.8438C7 14.8438 7 14.875 7 14.9062C7 14.9375 7.03125 15 7.03125 15.0312C7.0625 15.125 7.125 15.1875 7.1875 15.2812C7.46875 15.5938 7.9375 15.5938 8.25 15.3125C9.25 14.4062 10.25 13.5 11.25 12.5625C11.4062 12.4375 11.5 12.2188 11.5 12.0312C11.5 11.8125 11.4062 11.5938 11.25 11.4688C10.25 10.5625 9.25 9.625 8.25 8.71875C7.9375 8.4375 7.46875 8.46875 7.1875 8.75C7.125 8.84375 7.0625 8.90625 7.03125 9C7.03125 9.03125 7 9.09375 7 9.125ZM11 15.25C11 15.6875 11.3125 16 11.75 16H16.25C16.6562 16 17 15.6875 17 15.25C17 14.8438 16.6562 14.5 16.25 14.5H11.75C11.3125 14.5 11 14.8438 11 15.25Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
SDK
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Evaluation page" href="/products/evaluation" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M5.9375 10.125L3.6875 14H8.21875L5.9375 10.125ZM2 14.5625C1.9375 14.2188 2.03125 13.8438 2.21875 13.5625L5.1875 8.4375C5.34375 8.1875 5.625 8 5.9375 8C6.25 8 6.53125 8.1875 6.6875 8.4375L9.6875 13.5312C9.84375 13.8438 9.96875 14.2188 9.875 14.5625C9.5625 15.9375 7.90625 17 5.9375 17C4 17 2.34375 15.9375 2 14.5625ZM18 10.125L15.7188 14H20.25L18 10.125ZM14.0625 14.5625C13.9688 14.2188 14.0938 13.8438 14.25 13.5625L17.2188 8.4375C17.375 8.1875 17.6875 8 18 8C18.2812 8 18.5938 8.1875 18.75 8.4375L21.7188 13.5312C21.9062 13.8438 22 14.2188 21.9375 14.5625C21.5938 15.9375 19.9375 17 18 17C16.0312 17 14.375 15.9375 14.0625 14.5625Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M5 6C5 5.46875 5.4375 5 6 5H10C10.4375 4.40625 11.1562 4 12 4C12.8125 4 13.5312 4.40625 14 5H18C18.5312 5 19 5.46875 19 6C19 6.5625 18.5312 7 18 7H14.4375C14.2812 7.8125 13.7188 8.46875 13 8.8125V18H18C18.5312 18 19 18.4688 19 19C19 19.5625 18.5312 20 18 20H12H6C5.4375 20 5 19.5625 5 19C5 18.4688 5.4375 18 6 18H11V8.8125C10.25 8.5 9.6875 7.8125 9.53125 7H6C5.4375 7 5 6.5625 5 6Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Evaluations
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Retrieval page" href="/products/retrieval" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M18 9H14C13.4375 9 13 8.5625 13 8V4L18 9ZM14.5 13.5C14.5 14.0625 14.3438 14.5938 14.0625 15.0312L15.2812 16.25C15.5625 16.5312 15.5625 17 15.2812 17.3125C14.9688 17.5938 14.5 17.5938 14.2188 17.3125L13 16.0938C12.5625 16.375 12.0312 16.5 11.5 16.5C9.84375 16.5 8.5 15.1562 8.5 13.5C8.5 11.8438 9.84375 10.5 11.5 10.5C13.1562 10.5 14.5 11.8438 14.5 13.5ZM11.5 15C12.0312 15 12.5 14.7188 12.7812 14.25C13.0625 13.8125 13.0625 13.2188 12.7812 12.75C12.5 12.3125 12.0312 12 11.5 12C10.9375 12 10.4688 12.3125 10.1875 12.75C9.90625 13.2188 9.90625 13.8125 10.1875 14.25C10.4688 14.7188 10.9375 15 11.5 15Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M6 6C6 4.90625 6.875 4 8 4H13V8C13 8.5625 13.4375 9 14 9H18V18C18 19.125 17.0938 20 16 20H8C6.875 20 6 19.125 6 18V6ZM8.5 13.5C8.5 15.1562 9.84375 16.5 11.5 16.5C12.0312 16.5 12.5625 16.375 13 16.0938L14.2188 17.3125C14.3438 17.4375 14.5312 17.5312 14.75 17.5312C14.9375 17.5312 15.125 17.4375 15.2812 17.3125C15.5625 17 15.5625 16.5312 15.2812 16.25L14.0625 15.0312C14.3438 14.5938 14.5 14.0625 14.5 13.5C14.5 11.8438 13.1562 10.5 11.5 10.5C9.84375 10.5 8.5 11.8438 8.5 13.5ZM13 13.5C13 14.0625 12.6875 14.5312 12.25 14.8125C11.7812 15.0938 11.1875 15.0938 10.75 14.8125C10.2812 14.5312 10 14.0625 10 13.5C10 12.9688 10.2812 12.5 10.75 12.2188C11.1875 11.9375 11.7812 11.9375 12.25 12.2188C12.6875 12.5 13 12.9688 13 13.5Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Retrieval
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Deployment page" href="/products/deployments" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M10.9688 16.25C10.8438 14.5 9.4375 13.125 7.6875 13.0312C8.34375 11.5312 9.5 9.0625 10.4688 7.65625C13.0312 3.875 16.8438 3.75 19.0938 4.1875C19.4688 4.25 19.75 4.53125 19.8125 4.90625C20.25 7.15625 20.125 10.9688 16.3438 13.5312C14.9375 14.5 12.5 15.5938 10.9688 16.25ZM17.25 8C17.25 7.5625 17 7.15625 16.625 6.9375C16.2188 6.71875 15.75 6.71875 15.375 6.9375C14.9688 7.15625 14.75 7.5625 14.75 8C14.75 8.46875 14.9688 8.875 15.375 9.09375C15.75 9.3125 16.2188 9.3125 16.625 9.09375C17 8.875 17.25 8.46875 17.25 8Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M4 19.125C4.03125 17.9375 4.21875 15.875 5.3125 14.8125C6.375 13.75 8.125 13.75 9.1875 14.8125C10.25 15.875 10.25 17.625 9.1875 18.6875C8.125 19.7812 6.0625 19.9688 4.875 20C4.375 20.0312 3.96875 19.625 4 19.125ZM4.09375 12.625C3.9375 12.4062 3.96875 12.0938 4.09375 11.875L5.75 9.15625C6.15625 8.5 6.875 8.0625 7.65625 8.0625H10.1875C9.3125 9.5 8.3125 11.6562 7.6875 13H4.75C4.46875 13 4.21875 12.875 4.09375 12.625ZM6 17.5625C6 17.8125 6.1875 18 6.4375 18C6.84375 17.9688 7.40625 17.875 7.71875 17.5625C8.09375 17.2188 8.09375 16.625 7.71875 16.2812C7.375 15.9062 6.78125 15.9062 6.4375 16.2812C6.125 16.5938 6.03125 17.1562 6 17.5625ZM10.9688 16.25C12.3438 15.6562 14.5 14.6875 15.9062 13.8125V16.3438C15.9062 17.125 15.5 17.8438 14.8438 18.25L12.125 19.9062C12 19.9688 11.875 20 11.7188 20C11.5938 20 11.4688 19.9688 11.375 19.9062C11.125 19.7812 10.9688 19.5312 10.9688 19.25C10.9688 18.25 10.9688 17.25 10.9688 16.25Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Deployment
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Monitoring page" href="/products/monitoring" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M19.5312 5.53125L13.8438 11.2188C13.9375 11.4688 14 11.75 14 12C14 13.125 13.0938 14 12 14C10.875 14 10 13.125 10 12C10 10.9062 10.875 10 12 10C12.2812 10 12.5312 10.0625 12.7812 10.1875L18.4688 4.5C18.75 4.1875 19.2188 4.1875 19.5312 4.5C19.8125 4.78125 19.8125 5.25 19.5312 5.53125Z" fill="currentColor"></path>
                        <path opacity="0.4" d="M4 12C4 7.59375 7.5625 4 12 4C13.9375 4 15.6875 4.71875 17.0938 5.84375L15.6562 7.28125C14.6562 6.46875 13.375 6 12 6C9.09375 6 6.65625 8.0625 6.09375 10.8125C5.46875 10.9688 5 11.5625 5 12.25C5 13 5.53125 13.625 6.25 13.75C6.84375 15.75 8.46875 17.3125 10.5312 17.8438C10.6562 18.5 11.2812 19 12 19C12.7188 19 13.3125 18.5 13.4375 17.8438C16.0625 17.1875 18 14.8125 18 12H20C20 16.4375 16.4062 20 12 20C7.5625 20 4 16.4375 4 12ZM7.125 10.9062C7.625 8.6875 9.59375 7 12 7C13.0938 7 14.125 7.375 14.9375 8C14.4688 8.46875 14 8.9375 13.5 9.4375C13.0625 9.15625 12.5312 9 12 9C10.3438 9 9 10.3438 9 12C9 13.6562 10.3438 15 12 15C13.6562 15 15 13.6562 15 12H17C17 14.3125 15.4375 16.25 13.3125 16.8438C13.0625 16.3438 12.5625 16.0312 12 16.0312C11.4062 16.0312 10.9062 16.3438 10.6562 16.8438C9.03125 16.375 7.75 15.1562 7.21875 13.5625C7.6875 13.3125 8 12.8125 8 12.25C8 11.6562 7.625 11.125 7.125 10.9062Z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Observability
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                  </div>
                </nav>
              </div>
            </li>
            <li className="nav_list_item new hide-tablet">
              <div data-delay="200" data-hover="true" arialLabel="Hover on Products dropdown" className="nav_list_dropdown nav_new-link w-dropdown">
                <div className="dropdown_toggle u-hflex-center-center new-link w-dropdown-toggle">
                  <div>
Solutions
                  </div>
                  <svg width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_icon smaller">
                    <path opacity="0.4" d="M12.6875 16.7188C12.3125 17.125 11.6562 17.125 11.2812 16.7188L5.28125 10.7188C4.875 10.3438 4.875 9.6875 5.28125 9.3125C5.65625 8.90625 6.3125 8.90625 6.6875 9.3125L12 14.5938L17.2812 9.3125C17.6562 8.90625 18.3125 8.90625 18.6875 9.3125C19.0938 9.6875 19.0938 10.3438 18.6875 10.7188L12.6875 16.7188Z" fill="currentColor"></path>
                  </svg>
                </div>
                <nav className="dropdown_list dark-mode w-dropdown-list">
                  <div className="dropdown_list_inner">
                    <a aria-label="Go to Prompting page" href="https://www.vellum.ai/industries/healthcare" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M6 4.8C6 3.476 6.92 2.4 8.4 2.4L15.6 2.4C17.08 2.4 18 3.476 18 4.8L18 7.2L20.4 7.2C21.88 7.2 23 8.292 23 9.6L23 19.2C23 20.508 21.88 21.6 20.4 21.6L3.6 21.6C2.12 21.6 1 20.508 1 19.2L1 9.6C1 8.292 2.12 7.2 3.6 7.2L6 7.2L6 4.8zM11.4 15.6C10.736 15.6 10.2 16.152 10.2 16.8L10.2 19.8L13.8 19.8L13.8 16.8C13.8 16.152 13.264 15.6 12.6 15.6L11.4 15.6zM6 16.2L6 15C6 14.67 5.73 14.4 5.4 14.4L4.2 14.4C3.87 14.4 3.6 14.67 3.6 15L3.6 16.2C3.6 16.53 3.87 16.8 4.2 16.8L5.4 16.8C5.73 16.8 6 16.53 6 16.2zM5.4 12C5.73 12 6 11.73 6 11.4L6 10.2C6 9.87 5.73 9.6 5.4 9.6L4.2 9.6C3.87 9.6 3.6 9.87 3.6 10.2L3.6 11.4C3.6 11.73 3.87 12 4.2 12L5.4 12zM20.4 16.2L20.4 15C20.4 14.67 20.13 14.4 19.8 14.4L18.6 14.4C18.27 14.4 18 14.67 18 15L18 16.2C18 16.53 18.27 16.8 18.6 16.8L19.8 16.8C20.13 16.8 20.4 16.53 20.4 16.2zM19.8 12C20.13 12 20.4 11.73 20.4 11.4L20.4 10.2C20.4 9.87 20.13 9.6 19.8 9.6L18.6 9.6C18.27 9.6 18 9.87 18 10.2L18 11.4C18 11.73 18.27 12 18.6 12L19.8 12z" fill="currentColor"></path>
                        <path opacity="0.4" d="M11.1 6.3L11.1 7.5L9.9 7.5C9.57 7.5 9.3 7.77 9.3 8.1L9.3 8.7C9.3 9.03 9.57 9.3 9.9 9.3L11.1 9.3L11.1 10.5C11.1 10.83 11.37 11.1 11.7 11.1L12.3 11.1C12.63 11.1 12.9 10.83 12.9 10.5L12.9 9.3L14.1 9.3C14.43 9.3 14.7 9.03 14.7 8.7L14.7 8.1C14.7 7.77 14.43 7.5 14.1 7.5L12.9 7.5L12.9 6.3C12.9 5.97 12.63 5.7 12.3 5.7L11.7 5.7C11.37 5.7 11.1 5.97 11.1 6.3z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Healthcare
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Monitoring page" href="https://www.vellum.ai/industries/consumer-retail" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M2.4 6C2.4 4.67 3.47 3.6 4.8 3.6L9.8 3.6C10.45 3.6 11.06 3.86 11.51 4.3L16.9 9.7C17.85 10.66 17.85 12.34 16.9 13.29L11.9 18.3C10.95 19.25 9.27 19.25 8.32 18.3L3.11 13.0C2.66 12.25 2.41 11.64 2.41 11.0L2.4 6zM5.4 7.8C5.4 8.46 5.94 9.0 6.6 9.0C7.26 9.0 7.8 8.46 7.8 7.8C7.8 7.14 7.26 6.6 6.6 6.6C5.94 6.6 5.4 7.14 5.4 7.8z" fill="currentColor"></path>
                        <path opacity="0.4" d="M15.0 3.86C15.35 3.51 15.93 3.51 16.28 3.86L21.8 9.5C22.84 10.56 22.84 12.27 21.8 13.33L15.94 19.23C15.59 19.58 15.01 19.58 14.66 19.23C14.31 18.88 14.31 18.3 14.65 17.95L20.52 12.03C20.86 11.68 20.86 11.1 20.52 10.75L14.96 5.14C14.61 4.79 14.62 4.21 15.0 3.86z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Retail
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Evaluation page" href="https://www.vellum.ai/industries/supply-chain" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M5.4 12L18.6 12L18.6 14.4L5.4 14.4L5.4 12zM5.4 15.6L18.6 15.6L18.6 18L5.4 18L5.4 15.6zM5.4 19.2L18.6 19.2L18.6 21.6L5.4 21.6L5.4 19.2z" fill="currentColor"></path>
                        <path opacity="0.4" d="M1.2 20.4L1.2 7.73C1.2 6.7 1.86 5.78 2.84 5.45L11.43 2.59C11.8 2.47 12.2 2.47 12.57 2.59L21.16 5.45C22.12 5.78 22.8 6.7 22.8 7.73L22.8 20.4C22.8 21.14 22.27 21.6 21.6 21.6C20.93 21.6 20.4 21.14 20.4 20.4L20.4 11.4C20.4 10.73 19.87 10.2 19.2 10.2L4.8 10.2C4.13 10.2 3.6 10.73 3.6 11.4L3.6 20.4C3.6 21.14 3.07 21.6 2.4 21.6C1.73 21.6 1.2 21.14 1.2 20.4z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Supply chain
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Retrieval page" href="https://www.vellum.ai/industries/insurance" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M4.8 4.8L4.8 19.2C4.8 20.55 5.85 21.6 7.2 21.6L16.8 21.6C18.15 21.6 19.2 20.55 19.2 19.2L19.2 8.79C19.2 8.16 18.95 7.54 18.5 7.09L14.5 3.1C14.05 2.65 13.44 2.4 12.81 2.4L7.2 2.4C5.85 2.4 4.8 3.45 4.8 4.8zM7.2 5.7C7.2 5.2 7.6 4.8 8.1 4.8L9.9 4.8C10.4 4.8 10.8 5.2 10.8 5.7C10.8 6.2 10.4 6.6 9.9 6.6L8.1 6.6C7.6 6.6 7.2 6.2 7.2 5.7zM7.2 9.3C7.2 8.8 7.6 8.4 8.1 8.4L9.9 8.4C10.4 8.4 10.8 8.8 10.8 9.3C10.8 9.8 10.4 10.2 9.9 10.2L8.1 10.2C7.6 10.2 7.2 9.8 7.2 9.3zM7.4 17.74L9.65 14.92C9.91 14.59 10.31 14.4 10.73 14.4C11.35 14.4 11.89 14.8 12.07 15.39L12.67 17.4L15.9 17.4C16.4 17.4 16.8 17.8 16.8 18.3C16.8 18.8 16.4 19.2 15.9 19.2L12.0 19.2C11.6 19.2 11.25 18.94 11.14 18.56L10.56 16.66L8.8 18.86C8.49 19.25 7.92 19.31 7.54 18.95C7.16 18.57 7.1 17.96 7.4 17.74zM12.6 4.59L17.0 9.0L13.5 9.0C13.0 9.0 12.6 8.6 12.6 8.1L12.6 4.59z" fill="currentColor"></path>
                        <path opacity="0.4" d="M7.2 5.7C7.2 5.2 7.6 4.8 8.1 4.8L9.9 4.8C10.4 4.8 10.8 5.2 10.8 5.7C10.8 6.2 10.4 6.6 9.9 6.6L8.1 6.6C7.6 6.6 7.2 6.2 7.2 5.7zM7.2 9.3C7.2 8.8 7.6 8.4 8.1 8.4L9.9 8.4C10.4 8.4 10.8 8.8 10.8 9.3C10.8 9.8 10.4 10.2 9.9 10.2L8.1 10.2C7.6 10.2 7.2 9.8 7.2 9.3zM9.65 14.92C9.91 14.59 10.31 14.4 10.73 14.4C11.35 14.4 11.89 14.8 12.07 15.39L12.67 17.4L15.9 17.4C16.4 17.4 16.8 17.8 16.8 18.3C16.8 18.8 16.4 19.2 15.9 19.2L12.0 19.2C11.6 19.2 11.25 18.94 11.14 18.56L10.56 16.66L8.8 18.86C8.49 19.25 7.92 19.31 7.54 18.95C7.16 18.57 7.1 17.96 7.4 17.74L9.65 14.92z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Insurance
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                    <a aria-label="Go to Retrieval page" href="https://www.vellum.ai/industries/government" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                      <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                        <path d="M2.4 4.8C2.4 3.476 3.476 2.4 4.8 2.4L14.4 2.4C15.724 2.4 16.8 3.476 16.8 4.8L16.8 10.26C16.684 10.282 16.567 10.316 16.451 10.354L13.2 11.438L13.2 11.4C13.2 11.07 12.93 10.8 12.6 10.8L11.4 10.8C11.07 10.8 10.8 11.07 10.8 11.4L10.8 12.6C10.8 12.66 10.807 12.716 10.822 12.769C10.429 13.282 10.2 13.92 10.2 14.599L10.2 15.6L9.0 15.6C8.336 15.6 7.8 16.136 7.8 16.8L7.8 19.8L11.156 19.8C11.479 20.445 11.88 21.049 12.349 21.6L4.8 21.6C3.476 21.6 2.4 20.524 2.4 19.2L2.4 4.8zM6.0 6.6L6.0 7.8C6.0 8.13 6.27 8.4 6.6 8.4L7.8 8.4C8.13 8.4 8.4 8.13 8.4 7.8L8.4 6.6C8.4 6.27 8.13 6.0 7.8 6.0L6.6 6.0C6.27 6.0 6.0 6.27 6.0 6.6zM6.0 11.4L6.0 12.6C6.0 12.93 6.27 13.2 6.6 13.2L7.8 13.2C8.13 13.2 8.4 12.93 8.4 12.6L8.4 11.4C8.4 11.07 8.13 10.8 7.8 10.8L6.6 10.8C6.27 10.8 6.0 11.07 6.0 11.4zM10.8 6.6L10.8 7.8C10.8 8.13 11.07 8.4 11.4 8.4L12.6 8.4C12.93 8.4 13.2 8.13 13.2 7.8L13.2 6.6C13.2 6.27 12.93 6.0 12.6 6.0L11.4 6.0C11.07 6.0 10.8 6.27 10.8 6.6z" fill="currentColor"></path>
                        <path opacity="0.4" d="M17.4 20.955L17.899 20.719C19.792 19.83 21.0 17.925 21.0 15.832L21.0 15.098L17.4 13.898L17.4 20.951zM12.821 13.53L17.021 12.131C17.269 12.049 17.535 12.049 17.779 12.131L21.979 13.53C22.47 13.695 22.8 14.152 22.8 14.67L22.8 15.836C22.8 18.626 21.188 21.165 18.668 22.35L17.974 22.676C17.794 22.759 17.599 22.804 17.404 22.804C17.209 22.804 17.01 22.759 16.834 22.676L16.133 22.35C13.612 21.161 12.0 18.622 12.0 15.832L12.0 14.666C12.0 14.149 12.33 13.691 12.821 13.526z" fill="currentColor"></path>
                      </svg>
                      <div className="dropdown_link_text">
Government
                      </div>
                      <div className="nav_dropdown-linear"></div>
                    </a>
                  </div>
                </nav>
              </div>
            </li>
            <li className="nav_list_item new hide">
              <div data-delay="200" data-hover="true" arialLabel="Hover on Products dropdown" className="nav_list_dropdown nav_new-link w-dropdown">
                <div className="dropdown_toggle u-hflex-center-center new-link is-light w-dropdown-toggle">
                  <div className="nav_list_link is-light">
Resources
                  </div>
                  <svg width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_icon smaller new">
                    <path opacity="0.4" d="M12.6875 16.7188C12.3125 17.125 11.6562 17.125 11.2812 16.7188L5.28125 10.7188C4.875 10.3438 4.875 9.6875 5.28125 9.3125C5.65625 8.90625 6.3125 8.90625 6.6875 9.3125L12 14.5938L17.2812 9.3125C17.6562 8.90625 18.3125 8.90625 18.6875 9.3125C19.0938 9.6875 19.0938 10.3438 18.6875 10.7188L12.6875 16.7188Z" fill="currentColor"></path>
                  </svg>
                </div>
                <nav className="dropdown_list is--resources dark-mode w-dropdown-list">
                  <div className="dropdown_list_inner _2col dark-mode">
                    <div className="dropdown-column-wrap dark-mode">
                      <div className="dropdown_link_text text-color-purple nav_tag drak-mode">
Resources
                      </div>
                      <a aria-label="Go to LLM Parameters Guide page" href="/news" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                          <path d="M4.78125 16.6875L12 18.125L19.1875 16.6875C19.6562 16.5938 20 16.1562 20 15.6875V4.90625L20.7812 4.75C21.4062 4.625 22 5.09375 22 5.71875V17.1875C22 17.6562 21.6562 18.0938 21.1875 18.1875L12 20L2.78125 18.1875C2.3125 18.0938 2 17.6562 2 17.1875V5.71875C2 5.09375 2.5625 4.625 3.1875 4.75L4 4.90625V15.6875C4 16.1875 4.3125 16.5938 4.78125 16.6875Z" fill="currentColor"></path>
                          <path opacity="0.4" d="M4 5.0625C4 4.46875 4.53125 4 5.125 4.09375L11.5 5V18L4.78125 16.6875C4.3125 16.5938 4 16.1562 4 15.6875V5.0625ZM12.5 5L18.8438 4.09375C19.4375 4 20 4.46875 20 5.0625V15.6875C20 16.1562 19.6562 16.5938 19.1875 16.6875L12.5 18V5Z" fill="currentColor"></path>
                        </svg>
                        <div className="dropdown_link_text">
News
                        </div>
                        <div className="nav_dropdown-linear"></div>
                      </a>
                      <a aria-label="Go to Guides page" href="/blog" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                          <path d="M4 9C3.4375 9 3 8.5625 3 8V7C3 5.90625 3.875 5 5 5C6.09375 5 7 5.90625 7 7V9H4ZM12 16H11.9688C11.9688 15.4688 12.4375 15 12.9688 15H13.7188H13.7812C13.9062 15 14.0312 15.0625 14.125 15.1562L14.8125 15.8438C14.9062 15.9375 15.0625 15.9375 15.1562 15.8438L15.8438 15.1562C15.9375 15.0625 16.0625 15 16.1875 15H16.25H20C20.5312 15 21 15.4688 21 16C21 17.6562 19.6562 19 18 19H9.5C10.875 19 12 17.9062 12 16.5V16Z" fill="currentColor"></path>
                          <path opacity="0.4" d="M5 5H16C17.0938 5 18 5.90625 18 7V7.75V7.8125C18 7.9375 17.9375 8.0625 17.8438 8.15625L17.1562 8.84375C17.0625 8.9375 17.0625 9.09375 17.1562 9.1875L17.8438 9.875C17.9375 9.96875 18 10.0938 18 10.2188V10.2812V10.7812V10.8125C18 10.9375 17.9375 11.0625 17.8438 11.1562L17.1562 11.8438C17.0625 11.9375 17.0625 12.0938 17.1562 12.1875L17.8438 12.875C17.9375 12.9688 18 13.0938 18 13.2188V13.2812V15.0312H16.25H16.1875C16.0625 15.0312 15.9375 15.0625 15.8438 15.1562L15.1562 15.8438C15.0625 15.9375 14.9062 15.9375 14.8125 15.8438L14.125 15.1562C14.0312 15.0625 13.9062 15.0312 13.7812 15.0312H13.7188H12.9688C12.4375 15.0312 11.9688 15.4688 11.9688 16.0312V16.5312C11.9688 17.9062 10.875 19.0312 9.46875 19.0312C8.09375 19.0312 6.96875 17.9062 6.96875 16.5312V12.2812V12.2188C6.96875 12.0938 7.03125 11.9688 7.125 11.875L7.8125 11.1875C7.90625 11.0938 7.90625 10.9375 7.8125 10.8438L7.125 10.1562C7.03125 10.0625 6.96875 9.9375 6.96875 9.8125V9.78125V9.03125V7.03125C6.96875 5.90625 6.09375 5.03125 4.96875 5.03125L5 5Z" fill="currentColor"></path>
                        </svg>
                        <div className="dropdown_link_text">
Blog
                        </div>
                        <div className="nav_dropdown-linear"></div>
                      </a>
                      <a aria-label="Go to Leaderboards page" href="/llm-leaderboard" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                          <path d="M11 16.375C11 15.875 10.7188 15.4062 10.3438 15.0625C9 13.875 7.28125 11.2188 7.03125 5.5C6.96875 4.6875 7.65625 4 8.5 4H15.5C16.3125 4 17 4.6875 16.9688 5.5C16.6875 11.2188 14.9688 13.875 13.625 15.0625C13.25 15.4062 13 15.875 13 16.375V16.5C13 17.3438 13.6562 18 14.5 18H15C15.5312 18 16 18.4688 16 19C16 19.5625 15.5312 20 15 20H9C8.4375 20 8 19.5625 8 19C8 18.4688 8.4375 18 9 18H9.5C10.3125 18 11 17.3438 11 16.5V16.375Z" fill="currentColor"></path>
                          <path opacity="0.4" d="M3 6.75C3 6.34375 3.3125 6 3.75 6H7.03125C7.0625 6.53125 7.125 7.03125 7.1875 7.5H4.5C4.75 10.5625 6.40625 12.2188 8.09375 13.125C8.4375 13.3125 8.78125 13.4688 9.09375 13.5938C9.3125 13.9375 9.53125 14.1875 9.71875 14.4375C9.84375 14.5625 9.9375 14.6875 10.0312 14.7812C10.0938 14.8438 10.125 14.875 10.1875 14.9375C10.25 14.9688 10.2812 15 10.3438 15.0625C10.5312 15.2188 10.6875 15.4375 10.8125 15.6562C10.6562 15.625 10.5 15.5938 10.3125 15.5625C9.53125 15.375 8.46875 15.0312 7.375 14.4688C5.1875 13.25 3 10.9688 3 6.75ZM13.1562 15.6562H13.1875C13.2812 15.4375 13.4375 15.2188 13.625 15.0625C14.0312 14.7188 14.4375 14.25 14.8438 13.625C15.1875 13.4688 15.5312 13.3125 15.875 13.125C17.5625 12.2188 19.2188 10.5625 19.4688 7.5H16.7812C16.8438 7.03125 16.9062 6.53125 16.9375 6H20.25C20.6562 6 21 6.34375 21 6.75C21 10.9688 18.7812 13.25 16.5938 14.4375C15.5312 15.0312 14.4375 15.375 13.6562 15.5312C13.4688 15.5938 13.3125 15.625 13.1562 15.6562Z" fill="currentColor"></path>
                        </svg>
                        <div className="dropdown_link_text">
Leaderboards
                        </div>
                        <div className="nav_dropdown-linear"></div>
                      </a>
                      <a aria-label="Go to Product Updates page" href="/webinars" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                          <path d="M10.4062 6.3125L12.0312 9.875L15.5938 11.5C15.7812 11.5938 15.9062 11.7812 15.9062 11.9688C15.9062 12.1562 15.7812 12.3438 15.5938 12.4062L12.0312 14.0625L10.4062 17.625C10.3125 17.8125 10.125 17.9375 9.9375 17.9375C9.75 17.9375 9.5625 17.8125 9.5 17.625L7.84375 14.0625L4.28125 12.4375C4.09375 12.3438 4 12.1562 4 11.9688C4 11.7812 4.09375 11.5938 4.28125 11.5L7.84375 9.875L9.5 6.3125C9.5625 6.125 9.75 6 9.9375 6C10.125 6 10.3125 6.125 10.4062 6.3125Z" fill="currentColor"></path>
                          <path opacity="0.4" d="M14 7C14 6.875 14.0938 6.71875 14.2188 6.6875L16 6L16.6562 4.25C16.6875 4.09375 16.8438 4 17 4C17.125 4 17.2812 4.09375 17.3125 4.25L18 6L19.75 6.6875C19.9062 6.71875 20 6.875 20 7C20 7.15625 19.9062 7.3125 19.75 7.34375L18 8L17.3125 9.78125C17.2812 9.90625 17.125 10 17 10C16.8438 10 16.6875 9.90625 16.6562 9.78125L16 8L14.2188 7.34375C14.0938 7.3125 14 7.15625 14 7ZM14 17C14 16.875 14.0938 16.7188 14.2188 16.6875L16 16L16.6562 14.25C16.6875 14.0938 16.8438 14 17 14C17.125 14 17.2812 14.0938 17.3125 14.25L18 16L19.75 16.6875C19.9062 16.7188 20 16.875 20 17C20 17.1562 19.9062 17.3125 19.75 17.3438L18 18L17.3125 19.7812C17.2812 19.9062 17.125 20 17 20C16.8438 20 16.6875 19.9062 16.6562 19.7812L16 18L14.2188 17.3438C14.0938 17.3125 14 17.1562 14 17Z" fill="currentColor"></path>
                        </svg>
                        <div className="dropdown_link_text">
Webinars
                        </div>
                        <div className="nav_dropdown-linear"></div>
                      </a>
                      <a aria-label="Go to Free Tools page" href="/gpt-5-benchmarks-and-prompting-tips" target="_blank" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                        <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                          <path d="M5.46875 4.21875C5.71875 3.96875 6.15625 3.9375 6.4375 4.15625L9.6875 6.65625C9.875 6.8125 10 7.03125 10 7.25V8.9375L13.4062 12.3438C14.3125 11.9062 15.4375 12.0312 16.1875 12.8125L19.6875 16.3125C20.0938 16.6875 20.0938 17.3438 19.6875 17.7188L17.6875 19.7188C17.3125 20.125 16.6562 20.125 16.2812 19.7188L12.7812 16.2188C12.0312 15.4688 11.875 14.3125 12.3438 13.4062L8.9375 10H7.25C7 10 6.78125 9.90625 6.65625 9.71875L4.15625 6.46875C3.90625 6.1875 3.9375 5.75 4.21875 5.46875L5.46875 4.21875Z" fill="currentColor"></path>
                          <path opacity="0.4" d="M4 17.9062C4 17.3438 4.21875 16.7812 4.59375 16.4062L9.25 11.75L11.1875 13.6875C11 14.3438 11.0312 15.0625 11.2812 15.7188L7.59375 19.4062C7.21875 19.7812 6.65625 20 6.09375 20C4.9375 20 4 19.0625 4 17.9062ZM7.25 17.5C7.25 17.0938 6.90625 16.75 6.5 16.75C6.0625 16.75 5.75 17.0938 5.75 17.5C5.75 17.9375 6.0625 18.25 6.5 18.25C6.90625 18.25 7.25 17.9375 7.25 17.5ZM11 8.5C11 6.03125 13 4 15.5 4C15.8125 4 16.125 4.0625 16.4375 4.125C16.7812 4.1875 16.875 4.625 16.625 4.875L14.625 6.875C14.5312 6.96875 14.5 7.09375 14.5 7.21875V9C14.5 9.28125 14.7188 9.5 15 9.5L16.7812 9.53125C16.9062 9.53125 17.0312 9.46875 17.125 9.375L19.125 7.375C19.375 7.125 19.8125 7.21875 19.875 7.5625C19.9375 7.875 20 8.1875 20 8.5C20 10.3125 18.9375 11.875 17.4062 12.5938L16.9062 12.0938C16.0312 11.2188 14.7812 10.9062 13.6562 11.2188L11 8.53125C11 8.53125 11 8.53125 11 8.5Z" fill="currentColor"></path>
                        </svg>
                        <div className="dropdown_link_text">
GPT-5 Playbook
                        </div>
                        <div className="nav_dropdown-linear"></div>
                      </a>
                    </div>
                    <div id="w-node-a96c413e-e7e7-0140-ac47-2f6f46975ea8-46975e14" className="dropdown-column-wrap dark-mode alt">
                      <div className="dropdown_head-wrap">
                        <div className="dropdown_link_text text-color-purple nav_tag drak-mode">
Customer Spotlights
                        </div>
                        <a aria-label="Go to Case Studies page" href="/blog?category=Customer+Stories" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                          <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                            <path d="M8 4H11V9.96875C11 10.4062 11.4688 10.625 11.8125 10.375L13.5 9L15.1875 10.375C15.5 10.625 16 10.4062 16 9.96875V4H17H18C18.5312 4 19 4.46875 19 5V15C19 15.5625 18.5312 16 18 16H16H13H8C7.4375 16 7 16.4688 7 17C7 17.5625 7.4375 18 8 18H13H16H18C18.5312 18 19 18.4688 19 19C19 19.5625 18.5312 20 18 20H17H8C6.34375 20 5 18.6562 5 17V7C5 5.34375 6.34375 4 8 4Z" fill="currentColor"></path>
                            <path opacity="0.4" d="M7 17C7 16.4688 7.4375 16 8 16H13H16H18V18H16H13H8C7.4375 18 7 17.5625 7 17Z" fill="currentColor"></path>
                          </svg>
                          <div className="dropdown_link_text">
Case Studies
                          </div>
                          <div className="nav_dropdown-linear"></div>
                        </a>
                        <a aria-label="Go to LLM Basics page" href="/use-case-directory" className="dropdown_link u-hflex-left-center dark-mode w-inline-block">
                          <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="dropdown_link_icon">
                            <path d="M4 11C4 9.9375 4.5625 8.96875 5.5 8.40625C6.40625 7.875 7.5625 7.875 8.5 8.40625C9.40625 8.96875 10 9.9375 10 11C10 12.0938 9.40625 13.0625 8.5 13.625C7.5625 14.1562 6.40625 14.1562 5.5 13.625C4.5625 13.0625 4 12.0938 4 11ZM2 19.1875C2 16.875 3.84375 15 6.15625 15H7.8125C10.125 15 12 16.875 12 19.1875C12 19.625 11.625 20 11.1562 20H2.8125C2.34375 20 2 19.6562 2 19.1875ZM15 13H17C17.5312 13 18 13.4688 18 14V15H14V14C14 13.4688 14.4375 13 15 13Z" fill="currentColor"></path>
                            <path opacity="0.4" d="M7 6C7 4.90625 7.875 4 9 4H20C21.0938 4 22 4.90625 22 6V15C22 16.125 21.0938 17 20 17H12.5C12.1562 16.2188 11.5625 15.5312 10.875 15H14H18H20V6H9V7.5625C8.40625 7.21875 7.71875 7 7 7V6Z" fill="currentColor"></path>
                          </svg>
                          <div className="dropdown_link_text">
Use Cases
                          </div>
                          <div className="nav_dropdown-linear"></div>
                        </a>
                      </div>
                      <div className="dark_mode-feature">
                        <div className="w-dyn-list">
                          <div role="list" className="blog_coll_list is-nav w-dyn-items">
                            <div role="listitem" className="blog_coll_item u-vflex-stretch-top w-dyn-item">
                              <div className="blog_coll_wrap drak-mode">
                                <img alt src="https://cdn.prod.website-files.com/plugins/Basic/assets/placeholder.60f9b1840c.svg" className="blog_coll_image" />
                              </div>
                              <a aria-label="Go to blog post" href="/blog/coursemojo-case-study" className="u-cover-absolute is-nav w-inline-block"></a>
                              <div className="blog_tag-wrap">
                                <div data-wf--header-tag-new--variant="light" className="header_tag w-variant-11e7aa17-1e01-9a94-54a5-db6a960b027a">
                                  <div>
latest case study
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </nav>
              </div>
            </li>
            <li className="nav_list_item hide-mobile-nav"></li>
            <li className="nav_list_item new">
              <a aria-label="Go to Pricing" href="/pricing" aria-current="page" className="nav_list_link is-light w--current">
Pricing
              </a>
            </li>
            <li className="nav_list_item mobile-vertical is-light">
              <a aria-label="Go to Pricing" href="/community" className="nav_list_link is-light-stroke">
Community
              </a>
              <a aria-label="Go to Pricing" href="/templates" className="nav_list_link is-light-stroke">
Use Cases
              </a>
              <a aria-label="Go to Pricing" href="/blog" target="_blank" className="nav_list_link is-light-stroke">
Blog
              </a>
              <a aria-label="Go to Pricing" href="https://jobs.ashbyhq.com/vellum" target="_blank" className="nav_list_link is-light-stroke">
Careers
              </a>
            </li>
            <li className="nav_list_item hide-mobile-nav"></li>
          </ul>
          <div id="mobileclose" className="mobile_close">
            <div className="w-embed">
              <svg width="22" height="22" viewBox="0 0 22 22" fill="CurrentColor" display="block" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 1L1 21M1 1L21 21" stroke="white" strokeOpacity="0.6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"></path>
              </svg>
            </div>
          </div>
        </nav>
        <div className="navbar2_menu-button w-nav-button">
          <div className="menu-icon2">
            <div className="menu-icon2_line-top is-dark"></div>
            <div className="menu-icon2_line-middle is-dark">
              <div className="menu-icon2_line-middle-inner"></div>
            </div>
            <div className="menu-icon2_line-bottom is-dark"></div>
          </div>
        </div>
        <div id="w-node-a96c413e-e7e7-0140-ac47-2f6f46975f3f-46975e14" className="navbar2_button-wrapper hide-tablet new">
          <a href="/signup" target="_blank" className="d-button nav-button-5 js-utm-signup cta-get-started new w-inline-block">
            <div className="btn-text nav-button-6 new">
Get Started
            </div>
            <div className="btn_arrow nav-button-7 w-embed">
              <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M15.9062 10.2422L11.0938 14.8359C10.8203 15.082 10.4102 15.082 10.1641 14.8086C9.91797 14.5352 9.91797 14.125 10.1914 13.8789L13.8281 10.4062H4.53125C4.14844 10.4062 3.875 10.1328 3.875 9.75C3.875 9.39453 4.14844 9.09375 4.53125 9.09375H13.8281L10.1914 5.64844C9.91797 5.40234 9.91797 4.96484 10.1641 4.71875C10.4102 4.44531 10.8477 4.44531 11.0938 4.69141L15.9062 9.28516C16.043 9.42188 16.125 9.58594 16.125 9.75C16.125 9.94141 16.043 10.1055 15.9062 10.2422Z" fill="currentcolor"></path>
              </svg>
            </div>
            <div className="d-button_bg-overlay nav-button-8"></div>
          </a>
        </div>
      </div>
    </div>
  );
}
