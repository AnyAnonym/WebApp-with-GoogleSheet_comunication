class EmailMessagingAdapter {
  async send() {
    return { status: "not_configured" };
  }
}

module.exports = { EmailMessagingAdapter };
