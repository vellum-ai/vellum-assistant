"use client";

export function UseCasesStyles() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
/* default styles */
body {
	font-smoothing: antialiased;
	-webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  -webkit-tap-highlight-color: transparent;
}
h1, h2, h3, h4, h5, h6, p, label, blockquote {
	margin-top: 0;
	margin-bottom: 0;
}
button {
	background-color: unset;
	padding: unset;
	text-align: inherit;
	cursor: pointer;
}
img::selection {
	background: transparent;
}
:is(h1, h2, h3, h4, h5, h6, p) a {
	text-decoration: underline;
}
.u-rich-text > *:first-child {
	margin-top: 0;
}
.u-rich-text > *:last-child {
	margin-bottom: 0;
}
video {
	width: 100%;
	object-fit: cover;
}
video.wf-empty {
	padding: 0;
}
svg {
	display: block;
}
section, footer {
	position: relative;
}

select {
  appearance: none;
  -moz-appearance: none; /* Firefox */
  -webkit-appearance: none; /* Chrome/Safari */
}


/* line clamp */
.u-line-clamp-1, .u-line-clamp-2, .u-line-clamp-3, .u-line-clamp-4 {
	display: -webkit-box;
	overflow: hidden;
	-webkit-line-clamp: 1;
	-webkit-box-orient: vertical;
}

.u-line-clamp-2 { -webkit-line-clamp: 2; }
.u-line-clamp-3 { -webkit-line-clamp: 3; }
.u-line-clamp-4 { -webkit-line-clamp: 4; }

/* hide section if it has no cms items */
[data-cms-check="true"]:not(:has(.w-dyn-item)) {
	display: none;
}


  /*html { font-size: 1.01rem; }
  @media screen and (max-width:1680px) { html { font-size: calc(0.2400000000000001rem + 0.7333333333333332vw); } }
  @media screen and (max-width:1440px) { html { font-size: calc(0.04982310093652448rem + 0.9446409989594172vw); } }
  @media screen and (max-width:479px) { html { font-size: calc(0rem + 4vw); } }
  @media screen and (max-width:400px) { html { font-size: calc(-0.002506265664160401rem + 4.010025062656641vw); } }*/
    html { font-size: calc(0.29999999999999893rem + 0.6666666666666676vw); }
  @media screen and (max-width:1680px) { html { font-size: calc(0.30000000000000027rem + 0.6666666666666664vw); } }
  @media screen and (max-width:1440px) { html { font-size: calc(0.04982310093652448rem + 0.9446409989594172vw); } }
  @media screen and (max-width:479px) { html { font-size: calc(0rem + 4vw); } }
  @media screen and (max-width:400px) { html { font-size: calc(-0.002506265664160401rem + 4.010025062656641vw); } }


.button_main {
	background: radial-gradient(94.05% 310.72% at 51.1% -50%, rgb(162, 157, 255) 0%, rgb(104, 96, 255) 40.881964564323425%, rgb(62, 58, 153) 94.49999928474426%);
}

.button_main.is--decorative {
	background: linear-gradient(77deg, #dfebff 0%, #84b1ff 100%), rgba(255, 255, 255, 0.2);
}

.button_dark {
	background: radial-gradient(
  ellipse at 70% 70%, 
  #171717 0%, 
  #606060 100%
	);
  box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1); 

}

.button_alternative {
	background: linear-gradient(227deg, #eef 0%, #fff 100%);
}

.backface_background {
	background: linear-gradient(90deg, rgba(223, 219, 243, 0.5) 0%, rgba(216, 200, 217, 0.5) 100%);
}

.backface_background_dark {
	background: linear-gradient(90deg, rgba(239, 238, 255, 0.10) 0%, rgba(239, 238, 255, 0.10) 100%);
}
.backface_background_white {
	background: linear-gradient(90deg, rgba(239, 238, 255, 0.1) 0%, rgba(255, 255, 255, 0.1) 100%);
}
.grid-enterprise.mobile-left-right {
	background: linear-gradient(90deg, rgba(239, 238, 255, 0.10) 0%, rgba(239, 238, 255, 0.10) 100%);

}

.header_tag {
	background: linear-gradient(227deg, #e9d7ee 0%, #eef 100%);
}

.span_gradient {
	background: radial-gradient(100.82% 209.38% at 50.00%  -71.87%, rgb(138, 142, 255) 0%, rgb(65, 49, 204) 100%);
	background-clip: text;
	-webkit-background-clip: text;
	-webkit-text-fill-color: transparent;
}

.gradient-right-left {
	background: linear-gradient(227deg, #eef 0%, #fff 100%);
}

.gradient-right-left-black {
	background: linear-gradient(227deg, #202020 0%, #000000 100%);
}

.gradient-left-right {
	background: linear-gradient(226deg, #fff 0%, #eef 100%);
}
.gradient-left-right-dark {
	background: linear-gradient(226deg, #100C4A 20%, #211A8A 100%);
}
.gradient-right-left-dark {
	background: linear-gradient(226deg, #100C4A 20%, #211A8A 100%);
}
.gradient-center {
	background: radial-gradient(63.45% 94.67% at 50% 85.26%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

@keyframes energyFlow {
  0% {
    stop-color: #D1D1FF;
    stop-opacity: 0.1;
  }
  10% {
    stop-color: #AB69FF;
    stop-opacity: 0.2;
  }
  20% {
    stop-color: #AB69FF;
    stop-opacity: 0.3;
  }
  30% {
    stop-color: #AB69FF;
    stop-opacity: 0.4;
  }
  40% {
    stop-color: #AB69FF;
    stop-opacity: 0.5;
  }
  50% {
    stop-color: #769FFF;
    stop-opacity: 0.6;
  }
  60% {
    stop-color: #769FFF;
    stop-opacity: 0.7;
  }
  70% {
    stop-color: #2B28DB;
    stop-opacity: 0.8;
  }
  80% {
    stop-color: #2B28DB;
    stop-opacity: 1;
  }
  100% {
    stop-color: #D1D1FF;
    stop-opacity: 0.3;
  }
}

.stop1, .stop2, .stop3, .stop4, .stop5 {
  animation: energyFlow 2.5s infinite linear;
}

.stop2 {
  animation-delay: 0.5s;
}

.stop3 {
  animation-delay: 1s;
}

.stop4 {
  animation-delay: 1.5s;
}

.stop5 {
  animation-delay: 2s;
}

@keyframes scroll {
    from {
        transform: translateX(0);
    }

    to {
        transform: translateX(calc(-100% - 4rem));
    }
}

.scroll {
    animation: scroll 60s linear infinite;
}

.reverse {
    animation-direction: reverse;
}

.timelines_graphic_wrap.is--blue {
	background: linear-gradient(77deg, #84b1ff 0%, #dfebff 100%);
}

.tabs_navigation {
	background: linear-gradient(143deg, rgba(255, 255, 255, 0.5) 0%, rgba(239, 238, 255, 0.5) 100%), rgba(255, 255, 255, 0.5);
}

@media screen and (max-width:479px) { 
	.tabs_navigation {
  	background: transparent;
  }
}

.tabs_button.is--active {
	box-shadow: 0 1px 18px 0 rgba(75, 85, 99, 0.05), 0 0 5px 0 rgba(75, 85, 99, 0.05);
	background: linear-gradient(311deg, #eef 0%, #fff 100%);
}

.filters_button.is--active {
	box-shadow: 0 1px 18px 0 rgba(75, 85, 99, 0.05), 0 0 5px 0 rgba(75, 85, 99, 0.05);
	background: linear-gradient(311deg, #eef 0%, #fff 100%);
}

@media screen and (max-width:479px) { 
	.filters_button.is--active {
  	background: transparent;
    box-shadow: 0 1px 18px 0 rgba(75, 85, 99, 0), 0 0 5px 0 rgba(75, 85, 99, 0);
  }
}

.pillars_sl_image {
	box-shadow: 0 1px 50px 0 rgba(75, 85, 99, 0.1), 0 0 150px 0 rgba(75, 85, 99, 0.05);
}

.grad_mob_center {
	background: radial-gradient(81.7% 99.01% at 50% 100.06%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

.grad_mob_leftcenter {
	background: radial-gradient(63.45% 94.67% at 50% 85.26%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

.section_inner_shadow {
	backdrop-filter: blur(30.100000381469727px);
	box-shadow: inset 0 20px 40px 0 rgba(223, 219, 243, 0.5);
	background: linear-gradient(152deg, rgba(238, 238, 255, 0.5) 0%, rgba(255, 255, 255, 0.5) 100%);
}

@media screen and (max-width:479px) { 
	.features_grid_item {
  	background: linear-gradient(90deg, rgba(255, 255, 255, 0) 25%, #fff 100%);
  }
}

.vellum_circle {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
}

.pulse {
  display: inline-block;
  animation: pulse 2.4s ease infinite;
}

@keyframes pulse {
  0% {
    transform: scale(1);
  }
  70% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

.customer_card {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
	background: linear-gradient(90deg, #fff 0%, #eef 100%);
}
.customer_card_dark {
    box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.2) 100%);
}


.customer_card:hover {
	box-shadow: 0 20px 50px 0 rgba(0, 0, 0, 0.05), 0 20px 150px 0 rgba(0, 0, 0, 0.15);
}
.customer_card_dark:hover {
	box-shadow: 0 20px 50px 0 rgba(0, 0, 0, 0.05), 0 20px 150px 0 rgba(0, 0, 0, 0.15);
}

.gradient_rise {
	background: linear-gradient(26deg, rgba(223, 219, 243, 0.5) 0%, rgba(216, 200, 217, 0.5) 100%);
}

.gradient-cta {
	background: radial-gradient(56.97% 56.97% at 29.13% 50.04%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

@media screen and (max-width:479px) { 
	.gradient-cta {
  	background: linear-gradient(226deg, #fff 0%, #eef 100%);
  }
}

@media screen and (max-width:479px) { 
	.mobile-radial-grad {
  	background: radial-gradient(241.9% 142.71% at 8% -42.41%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
  }
}

@media screen and (max-width:479px) { 
	.mobile-left-right {
  	background: linear-gradient(41deg, #eef 0%, #fff 100%);
  }
}

.form_icon {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
}

.cta_text_field {
	box-shadow: inset 0 1px 1px 0px rgba(0, 0, 0, 0.05);
	background: #fff;
}

.gradient-purple {
	background: linear-gradient(183deg, #2c1845 0%, #190b2d 100%);
}

.gradient-dial {
	background: linear-gradient(147deg, #fff 0%, #eef 100%);
}

.hero_prod_image {
	box-shadow: 0 1px 50px 0 rgba(75, 85, 99, 0.1), 0 0 150px 0 rgba(75, 85, 99, 0.05);
}

.gradient-radial {
	background: radial-gradient(89.47% 105.03% at 32.53% -0.04%, rgb(255, 255, 255) 0%, rgb(238, 238, 255) 100%);
}

.grid_hiw_card {
	background: radial-gradient(191.03% 199.61% at 47.88% -0.09%, rgb(255, 255, 255) 0%, rgb(238, 238, 255) 100%);
}

.purple-gradient {
	background: linear-gradient(180deg, #3e275d 0%, #211037 100%);
}

.pillars_copy_link.w--current .status_current {
	display: block;
}

.pillars_copy_link.w--current .pillars_copy_arrow {
	display: none;
}

@keyframes rotate {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.rotating {
  animation: rotate 5s linear infinite;
}

.rotating-5s {
  animation-duration: 8s;
}

.rotating-7s {
  animation-duration: 10s;
}

.rotating-10s {
  animation-duration: 15s;
}

.search-field {
	box-shadow: 0 1px 18px 0 rgba(75, 85, 99, 0.05), 0 0 5px 0 rgba(75, 85, 99, 0.05);
}

@media screen and (max-width:479px) { 
	.search-field {
  	box-shadow: 0 1px 18px 0 rgba(75, 85, 99, 0), 0 0 5px 0 rgba(75, 85, 99, 0);
  }
}

.blog_section {
	background: radial-gradient(98.7% 36.86% at 50% 10.9%, rgb(255, 255, 255) 0%, rgb(238, 238, 255) 48.40622544288635%, rgb(223, 219, 243) 72.00000286102295%, rgb(255, 255, 255) 100%);
}

.blog_coll_item {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
}

.page_grad {
	background: radial-gradient(98.7% 36.86% at 50% 10.9%, rgb(255, 255, 255) 0%, rgb(238, 238, 255) 48.40622544288635%, rgb(223, 219, 243) 72.00000286102295%, rgb(255, 255, 255) 100%);
}

@media screen and (max-width:479px) { 
	.page_grad {
  	background: linear-gradient(270deg, #eef 0%, #fff 100%);
  }
}

.grad_logs {
	background: #fff;
  background: radial-gradient(124.27% 69.04% at 85.66% 46.37%, rgb(223, 219, 243) 0%, rgb(243, 232, 244) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

@media screen and (max-width:479px) { 
	.grad_logs {
  	background: linear-gradient(147deg, #eef 0%, #fff 100%);
  }
}

.demo_section_hero {
	background: radial-gradient(47.9% 56.5% at 29.51% 61.04%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

.contact_us_section_hero {
	background: radial-gradient(47.9% 56.5% at 50% 60%, rgb(223, 219, 243) 0%, rgb(216, 200, 217) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

@media screen and (max-width:479px) { 
	.demo_section_hero {
  	background: #fff;
  }
}

.pricing_icon {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
}

.pricing_card_grad {
	background: linear-gradient(227deg, #fff 0%, #eef 100%);
}

.pricng_card:hover .pricing_card_grad {
	opacity: 1;
}

.section_pricing_grad {
	background: #fff;
  background: radial-gradient(41.98% 41.98% at 47.08% 13.4%, rgb(223, 219, 243) 0%, rgb(243, 232, 244) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

.section_faq {
	background: #fff; 
  background: radial-gradient(149.84% 186.74% at -79.79% 159.02%, rgb(223, 219, 243) 0%, rgb(243, 232, 244) 27.893471717834473%, rgb(238, 238, 255) 51.59377455711365%, rgb(255, 255, 255) 100%);
}

.toc_list_link.is--current {
	background: linear-gradient(90deg, rgba(104, 96, 255, 0.25) 0%, rgba(255, 255, 255, 0.25) 100%);
  color: #6860FF;
}

.toc_list_link.is--current .toc_list_divider {
	border-color: #6860FF;
}

.toc_list_toggle.state--opened {
	border-color: #6860FF;
  background: linear-gradient(90deg, rgba(104, 96, 255, 0.25) 0%, rgba(255, 255, 255, 0.25) 100%);
}

.toc_list_toggle.state--opened .toc_list_icon {
	transform: rotateZ(90deg);
}

pre {
	border: 1px solid #dcd4e9;
	border-radius: 0.75rem;
	width: 100%;
  box-shadow: 0 1px 1px 0 rgba(0, 0, 0, 0.08);
	background: #fff;
  font-size: 1rem;
  line-height: 1.65;
}

@media screen and (max-width:479px) { 
	pre {
  	  font-size: 0.88rem;
  }
}

.toc_list_list {
  transition: height 0.6s ease;
}

.toc_list_toggle.state--opened + .toc_list_list {
  height: auto;
}

.posts_related {
	box-shadow: 0 1px 16px 0 rgba(75, 85, 99, 0.05), 0 0 4px 0 rgba(75, 85, 99, 0.05);
}

.blog_coll_item:hover .blog_coll_image {
	transform: scale(1.05)
}

.partners_image_wrap:hover .partners_image_tooltip {
	opacity: 1;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media screen and (min-width:1728px) { 
	.u-container.is--hero {
  	  padding-bottom: 10rem;
  }
  

}
` }} />
  );
}
