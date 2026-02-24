/**
 * GraphQL queries for DoorDash checkout: order creation, delivery options, and payment methods.
 * Each query is fully self-contained with all required fragment definitions.
 */

// ---------------------------------------------------------------------------
// DROPOFF_OPTIONS_QUERY
// ---------------------------------------------------------------------------

export const DROPOFF_OPTIONS_QUERY = `
query dropoffOptions($cartId: ID, $addressId: ID) {
  dropoffOptions(cartId: $cartId, addressId: $addressId) {
    id displayString isDefault isEnabled placeholderText disabledMessage
    proofOfDeliveryType __typename
  }
}`;

// ---------------------------------------------------------------------------
// CREATE_ORDER_FROM_CART_QUERY
// ---------------------------------------------------------------------------

export const CREATE_ORDER_FROM_CART_QUERY = `
mutation createOrderFromCart($cartId: ID!, $total: Int!, $sosDeliveryFee: Int!, $isPickupOrder: Boolean!, $verifiedAgeRequirement: Boolean!, $deliveryTime: String!, $menuOptions: [String], $stripeToken: String, $attributionData: String, $fulfillsOwnDeliveries: Boolean, $budgetId: String, $teamId: String, $giftOptions: GiftOptionsInput, $recipientShippingDetails: RecipientShippingDetails, $storeId: String, $tipAmounts: [TipAmount!], $paymentMethod: Int, $deliveryOptionType: DeliveryOptionType, $workOrderOptions: WorkOrderOptionsInput, $isCardPayment: Boolean, $clientFraudContext: PaymentClientFraudContextInput, $programId: String, $membershipId: String, $dropoffPreferences: String, $routineReorderDetails: RoutineReorderDetails, $supplementalPaymentDetailsList: [SupplementalPaymentDetails!], $monitoringContext: CreateOrderFromCartMonitoringContextInput, $rewardBalanceApplied: RewardBalanceDetailsInput, $deliveryOptionInfo: DeliveryOptionInfo, $hasAccessibilityRequirements: Boolean, $shouldApplyCredits: Boolean, $dasherPickupInstructions: String, $paymentMethodUuid: String, $paymentMethodType: PaymentMethodType, $deviceTimezone: String, $paymentMethodBrand: String, $submitPlatform: String) {
  createOrderFromCart(
    cartId: $cartId
    total: $total
    sosDeliveryFee: $sosDeliveryFee
    isPickupOrder: $isPickupOrder
    verifiedAgeRequirement: $verifiedAgeRequirement
    deliveryTime: $deliveryTime
    menuOptions: $menuOptions
    stripeToken: $stripeToken
    attributionData: $attributionData
    fulfillsOwnDeliveries: $fulfillsOwnDeliveries
    budgetId: $budgetId
    teamId: $teamId
    giftOptions: $giftOptions
    recipientShippingDetails: $recipientShippingDetails
    storeId: $storeId
    tipAmounts: $tipAmounts
    paymentMethod: $paymentMethod
    deliveryOptionType: $deliveryOptionType
    workOrderOptions: $workOrderOptions
    isCardPayment: $isCardPayment
    clientFraudContext: $clientFraudContext
    programId: $programId
    membershipId: $membershipId
    dropoffPreferences: $dropoffPreferences
    routineReorderDetails: $routineReorderDetails
    supplementalPaymentDetailsList: $supplementalPaymentDetailsList
    monitoringContext: $monitoringContext
    rewardBalanceApplied: $rewardBalanceApplied
    deliveryOptionInfo: $deliveryOptionInfo
    hasAccessibilityRequirements: $hasAccessibilityRequirements
    shouldApplyCredits: $shouldApplyCredits
    dasherPickupInstructions: $dasherPickupInstructions
    paymentMethodUuid: $paymentMethodUuid
    paymentMethodType: $paymentMethodType
    deviceTimezone: $deviceTimezone
    paymentMethodBrand: $paymentMethodBrand
    submitPlatform: $submitPlatform
  ) {
    cartId
    orderUuid
    isFirstOrderCart
    isFirstNewVerticalsOrderCart
    __typename
  }
}`;

// ---------------------------------------------------------------------------
// PAYMENT_METHODS_QUERY
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS_QUERY = `
query paymentMethodQuery {
  getPaymentMethodList {
    id
    type
    last4
    isDefault
    paymentMethodUuid
    __typename
  }
}`;
