resource "aws_security_group" "web" {
  name   = "${local.name_prefix}-web"
  vpc_id = module.vpc.vpc_id
  tags   = local.common_tags
}

resource "aws_instance" "web" {
  count = var.instance_count

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.micro"
  subnet_id              = module.vpc.public_subnet_ids[count.index]
  vpc_security_group_ids = [aws_security_group.web.id]

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-web-${count.index}"
  })
}
