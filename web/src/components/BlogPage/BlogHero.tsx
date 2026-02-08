const FILTER_CATEGORIES = [
  {
    label: "All",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f50a2cad08bc3b390eb5e9_Icon.svg",
  },
  {
    label: "LLM basics",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f50886f6e3e03c9aef2f2a_Icons.svg",
  },
  {
    label: "Product Updates",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f508ee4ed9a5aab6105f84_Icons.svg",
  },
  {
    label: "Guides",
    icon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/670416e02ab0997ea510d76f_Icons.svg",
  },
];

interface BlogPost {
  title: string;
  href: string;
  category: string;
  categoryColor?: string;
  categoryBgColor?: string;
  categoryIcon?: string;
  date: string;
  readTime: string;
  image: string;
  srcSet?: string;
}

const BLOG_POSTS: BlogPost[] = [
  {
    title: "Claude Opus 4.6 Benchmarks",
    href: "/blog/claude-opus-4-6-benchmarks",
    category: "Model Comparisons",
    date: "Feb 6, 2026",
    readTime: "10 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png",
  },
  {
    title: "AI Voice Agent Platforms Guide",
    href: "/blog/ai-voice-agent-platforms-guide",
    category: "LLM basics",
    date: "Feb 6, 2026",
    readTime: "12 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png",
  },
  {
    title: "15 Best Make Alternatives: Reviewed & Compared",
    href: "/blog/best-make-alternatives",
    category: "LLM basics",
    date: "Feb 5, 2026",
    readTime: "12 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68d58786dddc5a4b566f7b96_Vellum%20Standard%20Blog%20Cover.jpg",
    srcSet: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68d58786dddc5a4b566f7b96_Vellum%20Standard%20Blog%20Cover-p-500.jpg 500w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68d58786dddc5a4b566f7b96_Vellum%20Standard%20Blog%20Cover-p-800.jpg 800w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68d58786dddc5a4b566f7b96_Vellum%20Standard%20Blog%20Cover-p-1080.jpg 1080w, https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68d58786dddc5a4b566f7b96_Vellum%20Standard%20Blog%20Cover.jpg 1280w",
  },
  {
    title: "Vellum Product Update | January",
    href: "/blog/vellum-product-update-january-2026",
    category: "Product Updates",
    categoryColor: "#12b76a",
    categoryBgColor: "#ecfdf5",
    categoryIcon: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/66f51fbc4ccaf48d43a691b6_Icon.svg",
    date: "Feb 3, 2026",
    readTime: "5 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png",
  },
  {
    title: "15 Best Zapier Alternatives: Reviewed & Compared",
    href: "/blog/best-zapier-alternatives",
    category: "LLM basics",
    date: "Jan 30, 2026",
    readTime: "20 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png",
  },
  {
    title: "2026 Marketer's Guide to AI Agents for Marketing Operations",
    href: "/blog/complete-ai-agents-guide-for-marketing",
    category: "LLM basics",
    date: "Jan 28, 2026",
    readTime: "20 min",
    image: "https://cdn.prod.website-files.com/63f416b32254e8679cd8af88/68f62df5488ea1fb9508c764_Vellum%20Standard%20Blog%20Cover%20Small.png",
  },
];

const LOADER_ICON = (
  <svg width="100%" viewBox="0 0 24 24" fill="none" className="lottie-loader is--static">
    <path opacity="0.4" d="M10.0533 0L12.0002 4.22598L13.9394 0H15.894L11.9848 8.04249L8.10645 0H10.0533Z" fill="#A29DFF" />
    <g opacity="0.5">
      <path d="M19.1091 2.13837L17.4975 6.50325L21.8569 4.88622L23.239 6.26834L14.7879 9.191L17.7324 0.761719L19.1091 2.13837Z" fill="#A29DFF" />
    </g>
    <g opacity="0.6">
      <path d="M24 10.0533L19.774 12.0002L24 13.9394V15.894L15.9575 11.9848L24 8.10645V10.0533Z" fill="#6860FF" />
    </g>
    <g opacity="0.7">
      <path d="M21.8616 19.1086L17.4968 17.497L19.1138 21.8564L17.7317 23.2386L14.809 14.7874L23.2383 17.7319L21.8616 19.1086Z" fill="#6860FF" />
    </g>
    <g opacity="0.8">
      <path d="M13.9467 24L11.9998 19.774L10.0606 24H8.10602L12.0152 15.9575L15.8936 24H13.9467Z" fill="#6860FF" />
    </g>
    <g opacity="0.9">
      <path d="M4.89092 21.8616L6.50248 17.4968L2.14308 19.1138L0.760956 17.7317L9.21209 14.809L6.26758 23.2383L4.89092 21.8616Z" fill="#6860FF" />
    </g>
    <path d="M0 13.9467L4.22598 11.9998L0 10.0606L0 8.10602L8.04249 12.0152L0 15.8936L0 13.9467Z" fill="#6860FF" />
    <g opacity="0.3">
      <path d="M2.13837 4.89141L6.50325 6.50297L4.88622 2.14356L6.26834 0.761445L9.191 9.21258L0.761719 6.26807L2.13837 4.89141Z" fill="#6860FF" />
    </g>
  </svg>
);

const PAGINATION_ARROW = (
  <svg width="100%" viewBox="0 0 20 20" fill="none" className="pagination_icon">
    <path d="M15.4844 10.082L11.0156 14.3477C10.7617 14.5762 10.3809 14.5762 10.1523 14.3223C9.92383 14.0684 9.92383 13.6875 10.1777 13.459L13.5547 10.2344H4.92188C4.56641 10.2344 4.3125 9.98047 4.3125 9.625C4.3125 9.29492 4.56641 9.01562 4.92188 9.01562H13.5547L10.1777 5.81641C9.92383 5.58789 9.92383 5.18164 10.1523 4.95312C10.3809 4.69922 10.7871 4.69922 11.0156 4.92773L15.4844 9.19336C15.6113 9.32031 15.6875 9.47266 15.6875 9.625C15.6875 9.80273 15.6113 9.95508 15.4844 10.082Z" fill="#667085" />
  </svg>
);

function BlogPostCard({ post }: { post: BlogPost }) {
  const hasCustomCategory = post.categoryColor && post.categoryBgColor;
  const categoryStyle = hasCustomCategory
    ? { color: post.categoryColor, backgroundColor: post.categoryBgColor }
    : undefined;

  return (
    <div role="listitem" className="blog_coll_item u-vflex-stretch-top w-dyn-item">
      <div className="blog_coll_wrap">
        <img
          src={post.image}
          alt=""
          sizes={post.srcSet ? "100vw" : undefined}
          srcSet={post.srcSet}
          className="blog_coll_image"
        />
      </div>
      <div className="blog_coll_body u-vflex-stretch-top">
        <div className="u-hflex-between-center">
          <div
            className={`blog_coll_tag u-hflex-left-center${hasCustomCategory ? " is--green" : ""}`}
            style={categoryStyle}
          >
            {post.categoryIcon ? (
              <img src={post.categoryIcon} loading="lazy" alt="" className="blog_coll_icon" />
            ) : (
              <img
                src="https://cdn.prod.website-files.com/plugins/Basic/assets/placeholder.60f9b1840c.svg"
                loading="lazy"
                alt=""
                className="blog_coll_icon w-dyn-bind-empty"
              />
            )}
            <div>{post.category}</div>
          </div>
          <div className="u-hflex-center-center gap-filters">
            <div className="info_small_text">{post.date}</div>
            <div className="info_small_text">&bull;</div>
            <div className="info_small_text">{post.readTime}</div>
          </div>
        </div>
        <div className="blog_coll_title u-text-regular">{post.title}</div>
      </div>
      <a aria-label="Go to blog post" href={post.href} className="u-cover-absolute w-inline-block" />
    </div>
  );
}

export function BlogHero() {
  return (
    <section className="overflow-hidden">
      <div className="u-container is--hero-blog">
        <div className="hero_container_blog u-vflex-center-top gap-prod">
          <div className="u-vflex-center-top gap-medium">
            <h1 className="u-text-h1 blog-text">The Latest Learnings in AI</h1>
            <p className="u-text-regular text-center">
              Drowning in AI information? Experts at Vellum distill the latest and greatest into
              bite-sized articles to keep you informed.
            </p>
          </div>
        </div>

        <div className="u-hflex-center-center">
          <div className="filters_wrap">
            <div className="filters_form_block w-form">
              <form
                id="wf-form-Filters-Form"
                name="wf-form-Filters-Form"
                data-name="Filters Form"
                method="get"
                className="pad-bot-20"
              >
                <div className="pad-bot u-hflex-center-center w-dyn-list">
                  <div role="list" className="filters_form tabs_navigation u-hflex-center-center w-dyn-items">
                    {FILTER_CATEGORIES.map((cat) => (
                      <div key={cat.label} role="listitem" className="w-dyn-item">
                        <label className="filters_button u-hflex-center-center w-radio">
                          <img src={cat.icon} alt="" className="tabs_button_icon is--blog" />
                          <input
                            type="radio"
                            data-name="Radio"
                            name="radio"
                            className="w-form-formradioinput display-none w-radio-input"
                            value="Radio"
                          />
                          <span className="rb_label w-form-label">{cat.label}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="u-hflex-between-center gap-main">
                  <div className="status_text">
                    <span className="status_active">6</span>
                    {" / "}
                    <span className="status_total">{BLOG_POSTS.length}</span>
                    {" posts"}
                  </div>
                  <input
                    className="search-field w-input"
                    maxLength={256}
                    name="Search-Field"
                    data-name="Search Field"
                    placeholder=""
                    type="text"
                    id="Search-Field"
                  />
                </div>
              </form>
            </div>
          </div>
        </div>

        <div className="w-dyn-list">
          <div className="blog_coll_list w-dyn-items" role="list">
            {BLOG_POSTS.map((post) => (
              <BlogPostCard key={post.href} post={post} />
            ))}
          </div>
          <div role="navigation" aria-label="List" className="w-pagination-wrapper pagination u-hflex-center-center">
            <div className="u-hflex-center-center gap-filters">
              <a href="#" className="pagination_page_button w-inline-block">
                <div>1</div>
              </a>
              <div className="pagination_page_button">..</div>
            </div>
            <a href="?a027ee7e_page=2" aria-label="Next Page" className="w-pagination-next pagination_button_next u-hflex-center-center">
              {PAGINATION_ARROW}
            </a>
            <div aria-label="Page 1 of 36" role="heading" className="w-page-count display-none">
              1 / 36
            </div>
          </div>
        </div>

        <div className="empty_state u-vflex-center-center">
          {LOADER_ICON}
        </div>
      </div>
      <div className="backface_block page_grad" />
    </section>
  );
}
