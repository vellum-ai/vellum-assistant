import Image from "next/image";

const ARROW_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 24 24" fill="none" className="button_icon">
    <path d="M18.8438 12.375L13.3438 17.875C13.1562 18.0625 12.8125 18.0625 12.625 17.875C12.4375 17.6875 12.4375 17.3438 12.625 17.1562L17.2812 12.5H5.5C5.21875 12.5 5 12.2812 5 12C5 11.75 5.21875 11.5 5.5 11.5H17.2812L12.625 6.875C12.4375 6.6875 12.4375 6.34375 12.625 6.15625C12.8125 5.96875 13.1562 5.96875 13.3438 6.15625L18.8438 11.6562C19.0312 11.8438 19.0312 12.1875 18.8438 12.375Z" fill="currentColor" />
  </svg>
);

export function BlogNewsletter() {
  return (
    <section className="grad_logs">
      <div className="u-container is--logs u-hflex-left-center">
        <div className="logs_copy u-vflex-left-top">
          <h2 className="u-text-h2 is--xsmall mobile-center">
            Last week&apos;s News. <br />
            This week&apos;s Feature.
          </h2>
          <p className="u-text-regular mobile-center">
            Don&apos;t settle for subpar AI performance. Use the latest and greatest AI development
            tech with Vellum.
          </p>
          <a href="https://docs.vellum.ai/changelog" target="_blank" className="button_alternative w-inline-block" rel="noreferrer">
            {ARROW_ICON}
            <div>Changelog</div>
          </a>
        </div>
        <div className="w-dyn-list">
          <div role="list" className="w-dyn-items">
            <div role="listitem" className="logs_container u-hflex-left-center w-dyn-item">
              <Image
                src="https://cdn.prod.website-files.com/plugins/Basic/assets/placeholder.60f9b1840c.svg"
                loading="lazy"
                alt=""
                className="logs_image w-dyn-bind-empty"
                width={0}
                height={0}
                unoptimized
              />
              <div className="logs_container_copy u-vflex-stretch-top">
                <div
                  style={{ backgroundColor: "#ecfdf5", color: "#12b76a" }}
                  className="blog_coll_tag u-hflex-left-center is--green"
                >
                  <Image
                    src="https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f51fbc4ccaf48d43a691b6_Icon.svg"
                    loading="lazy"
                    alt=""
                    className="blog_coll_icon"
                    width={0}
                    height={0}
                    unoptimized
                  />
                  <div>PRODUCT UPDATES</div>
                </div>
                <div className="blog_coll_title">Vellum Product Update | January</div>
                <div className="text-descrip">
                  Workflow Sandbox upgrades, chat message triggers, realistic mocks, and new ways to
                  refine agent outputs.
                </div>
                <div className="u-hflex-left-center gap-xxsmall">
                  <div className="info_small_text">Feb 3, 2026</div>
                  <div className="info_small_text">&bull;</div>
                  <div className="info_small_text">5 min</div>
                </div>
              </div>
              <a
                aria-label="Go to Updates page"
                href="/blog/vellum-product-update-january-2026"
                className="u-cover-absolute w-inline-block"
              />
            </div>
          </div>
          <div role="navigation" aria-label="List" className="w-pagination-wrapper" />
        </div>
      </div>
    </section>
  );
}
