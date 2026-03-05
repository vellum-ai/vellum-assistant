/**
 * Type definitions for DoorDash GraphQL API responses.
 * These model the raw shapes returned by the API before extraction
 * into the public-facing interfaces (SearchResult, StoreInfo, etc.).
 */

// ---------------------------------------------------------------------------
// Shared / reusable fragments
// ---------------------------------------------------------------------------

export interface DDTextAttributes {
  textStyle?: string;
  textColor?: string;
}

export interface DDText {
  title?: string;
  titleTextAttributes?: DDTextAttributes;
  subtitle?: string;
  subtitleTextAttributes?: DDTextAttributes;
  accessory?: string;
  accessoryTextAttributes?: DDTextAttributes;
  description?: string;
}

export interface DDImage {
  uri?: string;
}

export interface DDImages {
  main?: DDImage;
}

export interface DDClickEvent {
  data?: string;
}

export interface DDEvents {
  click?: DDClickEvent;
}

export interface DDAddress {
  displayAddress?: string;
}

export interface DDRatings {
  averageRating?: number;
  numRatingsDisplayString?: string;
}

export interface DDFeeLayout {
  title?: string;
}

export interface DDPrice {
  display_string?: string;
  displayString?: string;
  unit_amount?: number;
  unitAmount?: number;
}

// ---------------------------------------------------------------------------
// Search / Feed responses
// ---------------------------------------------------------------------------

export interface DDFacetItem {
  id?: string;
  childrenCount?: number;
  component?: { id?: string; category?: string };
  name?: string;
  text?: DDText;
  images?: DDImages;
  events?: DDEvents;
  childrenMap?: DDFacetItem[];
}

export interface DDFeedSection {
  id?: string;
  header?: DDFacetItem;
  body?: DDFacetItem[];
  layout?: { omitFooter?: boolean };
}

export interface DDFacetFeed {
  body?: DDFeedSection[];
  page?: DDFacetItem;
  header?: DDFacetItem;
  footer?: DDFacetItem;
  custom?: string;
  logging?: string;
}

export interface DDSearchClickData {
  store_id?: string | number;
  storeId?: string | number;
}

// ---------------------------------------------------------------------------
// Store page responses
// ---------------------------------------------------------------------------

export interface DDStoreHeader {
  id?: string;
  name?: string;
  description?: string;
  address?: DDAddress;
  ratings?: DDRatings;
  deliveryFeeLayout?: DDFeeLayout;
  deliveryTimeLayout?: DDFeeLayout;
  priceRangeDisplayString?: string;
}

export interface DDMenuCategory {
  id?: string;
  name?: string;
  numItems?: number;
}

export interface DDMenuBook {
  menuCategories?: DDMenuCategory[];
}

export interface DDStoreItem {
  id?: string;
  name?: string;
  description?: string;
  displayPrice?: string;
  imageUrl?: string;
  imgUrl?: string;
  storeId?: string;
}

export interface DDItemList {
  items?: DDStoreItem[];
}

export interface DDCarousel {
  items?: DDStoreItem[];
}

export interface DDStorepageFeed {
  storeHeader?: DDStoreHeader;
  menuBook?: DDMenuBook;
  itemLists?: DDItemList[];
  carousels?: DDCarousel[];
}

// ---------------------------------------------------------------------------
// Retail store feed responses
// ---------------------------------------------------------------------------

export interface DDRetailStoreStatus {
  delivery?: { etaDisplayString?: string };
}

export interface DDRetailStoreHeader {
  name?: string;
  description?: string;
  address?: DDAddress;
  ratings?: DDRatings;
  deliveryFeeLayout?: DDFeeLayout;
  priceRangeDisplayString?: string;
  status?: DDRetailStoreStatus;
}

export interface DDRetailStoreDetails {
  id?: string;
  name?: string;
  storeHeader?: DDRetailStoreHeader;
}

export interface DDRetailProduct {
  id?: string;
  name?: string;
  description?: string;
  displayPrice?: string;
  imageUrl?: string;
  imgUrl?: string;
  storeId?: string;
  price?: DDPrice;
}

export interface DDRetailCollection {
  products?: DDRetailProduct[];
  items?: DDRetailProduct[];
}

export interface DDRetailL1Category {
  id?: string;
  name?: string;
  numItems?: number;
}

export interface DDRetailStorePageFeed {
  storeDetails?: DDRetailStoreDetails;
  l1Categories?: DDRetailL1Category[];
  collections?: DDRetailCollection[];
  page?: unknown;
}

// ---------------------------------------------------------------------------
// Retail search responses
// ---------------------------------------------------------------------------

export interface DDRetailItemImage {
  remote?: { uri?: string };
}

export interface DDRetailItemPrice {
  display_string?: string;
  unit_amount?: number;
}

export interface DDRetailItemData {
  item_id?: string | number;
  item_name?: string;
  description?: string;
  store_id?: string | number;
  menu_id?: string | number;
  price?: DDRetailItemPrice;
}

export interface DDRetailItemCustom {
  item_data?: DDRetailItemData;
  image?: DDRetailItemImage;
}

export interface DDLegoRetailItem {
  custom?: string;
}

export interface DDSearchSummary {
  totalCount?: number;
  suggestedSearchKeyword?: string;
}

export interface DDRetailSearchResult {
  legoRetailItems?: DDLegoRetailItem[];
  searchSummary?: DDSearchSummary;
}

// ---------------------------------------------------------------------------
// Item page responses
// ---------------------------------------------------------------------------

export interface DDItemHeader {
  id?: string;
  name?: string;
  description?: string;
  displayString?: string;
  unitAmount?: number;
  currency?: string;
  imgUrl?: string;
  menuId?: string;
}

export interface DDOptionChoice {
  id?: string;
  name?: string;
  displayString?: string;
  unitAmount?: number;
  defaultQuantity?: number;
  nestedExtrasList?: DDNestedExtra[];
}

export interface DDNestedExtra {
  id?: string;
  name?: string;
  isOptional?: boolean;
  options?: DDNestedExtraChoice[];
}

export interface DDNestedExtraChoice {
  id?: string;
  name?: string;
  displayString?: string;
}

export interface DDOptionList {
  id?: string;
  name?: string;
  isOptional?: boolean;
  minNumOptions?: number;
  maxNumOptions?: number;
  options?: DDOptionChoice[];
}

export interface DDSpecialInstructions {
  characterMaxLength?: number;
  placeholderText?: string;
  isEnabled?: boolean;
}

export interface DDItemPreferences {
  specialInstructions?: DDSpecialInstructions;
}

export interface DDItemPage {
  itemHeader?: DDItemHeader;
  optionLists?: DDOptionList[];
  itemPreferences?: DDItemPreferences;
}

// ---------------------------------------------------------------------------
// Cart responses
// ---------------------------------------------------------------------------

export interface DDCartItemDetail {
  name?: string;
}

export interface DDOrderItem {
  id?: string;
  item?: DDCartItemDetail;
  quantity?: number;
  priceDisplayString?: string;
}

export interface DDOrder {
  orderItems?: DDOrderItem[];
}

export interface DDCartRestaurant {
  id?: string;
  name?: string;
}

export interface DDCart {
  id?: string;
  restaurant?: DDCartRestaurant;
  orders?: DDOrder[];
  subtotal?: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Dropoff options responses
// ---------------------------------------------------------------------------

export interface DDDropoffOption {
  id?: string;
  displayString?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Payment method responses
// ---------------------------------------------------------------------------

export interface DDPaymentMethod {
  id?: string;
  type?: string;
  last4?: string;
  isDefault?: boolean;
  paymentMethodUuid?: string;
  uuid?: string;
}

// ---------------------------------------------------------------------------
// Order responses
// ---------------------------------------------------------------------------

export interface DDCreateOrderResult {
  cartId?: string;
  orderUuid?: string;
}
